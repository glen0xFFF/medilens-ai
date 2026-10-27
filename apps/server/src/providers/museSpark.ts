/**
 * Meta Muse Spark adapters (spec §4.2). The label reader only transcribes. The
 * answerer is deterministic for every intent but explain_text; for that one
 * the model sees only the printed sentence around the asked phrase and returns
 * a short explanation that the server gates and composes around a verbatim
 * quote of that sentence (domain/answers.ts).
 * No env access here: the HTTP layer builds the client and passes it in.
 */
import {
  ExtractedLabelSchema,
  FieldKeySchema,
  ImageKindSchema,
  LegibilitySchema,
  type Answer,
  type ExtractedLabel,
  type LabelField,
} from '@medilens/contracts';
import OpenAI from 'openai';
import { z } from 'zod';
import {
  ANSWER_FALLBACK_TEXT,
  PHRASE_NOT_FOUND_TEXT,
  answerFromLabel,
  composeExplainAnswer,
  explainQuote,
  explanationAllowed,
  unclearAnswer,
} from '../domain/answers';
import { extractExplainPhrase } from '../domain/safety';
import { EXPLAIN_SYSTEM_PROMPT, READER_SYSTEM_PROMPT, readerUserText } from './prompts';
import type {
  AnswerInput,
  LabelReader,
  ProviderContext,
  QuestionAnswerer,
  ReadResult,
} from './types';

export type ChatClient = Pick<OpenAI['chat']['completions'], 'create'>;

export interface ModelUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface MuseSparkOptions {
  model?: string;
  /** Called after every completion that returned, before its output is checked. */
  onUsage?: (usage: ModelUsage) => void;
}

export const MUSE_MODEL = 'muse-spark-1.3';
const META_BASE_URL = 'https://api.meta.ai/v1';
const MAX_TOKENS = 4000;
const REASONING_EFFORT = 'low';
const MAX_IMAGES = 3;

export { ANSWER_FALLBACK_TEXT, PHRASE_NOT_FOUND_TEXT };

/** The Meta Model API is OpenAI-compatible; only the chat completions surface is used. */
export function createMetaClient(apiKey: string): ChatClient {
  return new OpenAI({ baseURL: META_BASE_URL, apiKey }).chat.completions;
}

/* --------------------------------------------------------------- schemas */

const ModelFieldSchema = z.object({
  value: z.string().nullable(),
  legibility: LegibilitySchema,
  evidenceText: z.string().nullable(),
  notes: z.string().nullable(),
});

/**
 * What the model returns: one entry per field key (so none can be missing or
 * repeated), mapped to the contracts ExtractedLabel after validation.
 */
export const ModelLabelSchema = z.object({
  imageKind: ImageKindSchema,
  fields: z.object({
    brandName: ModelFieldSchema,
    genericNames: ModelFieldSchema,
    strength: ModelFieldSchema,
    dosageForm: ModelFieldSchema,
    manufacturer: ModelFieldSchema,
    registrationNumber: ModelFieldSchema,
    directions: ModelFieldSchema,
    warnings: ModelFieldSchema,
    storage: ModelFieldSchema,
    expiryDate: ModelFieldSchema,
    batchNumber: ModelFieldSchema,
    rxOrOtc: ModelFieldSchema,
  }),
  rawText: z.string(),
  warnings: z.array(z.string()),
});
type ModelLabel = z.infer<typeof ModelLabelSchema>;

/** What the explain call returns: one explanation string and nothing else. */
const ModelExplanationSchema = z.strictObject({ explanation: z.string() });

/** Strict-mode JSON Schema: every field inlined (no $ref), nullable as ["string","null"]. */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: 'draft-7', io: 'output', reused: 'inline' });
  const { $schema: _drop, ...rest } = out as Record<string, unknown>;
  return rest;
}

const LABEL_JSON_SCHEMA = jsonSchema(ModelLabelSchema);
const EXPLANATION_JSON_SCHEMA = jsonSchema(ModelExplanationSchema);

/* ------------------------------------------------------------ completion */

type Params = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
type Attempt<T> =
  { kind: 'ok'; value: T; model: string } | { kind: 'invalid' } | { kind: 'contributor' };

/**
 * One completion: reports usage, guards the serving model, then parses and
 * validates the JSON content. A cut-off (finish_reason length), a refusal,
 * non-JSON or schema-invalid content is 'invalid'.
 */
async function complete<T>(
  client: ChatClient,
  params: Params,
  schema: z.ZodType<T>,
  onUsage: MuseSparkOptions['onUsage'],
): Promise<Attempt<T>> {
  const res = await client.create(params);
  if (res.usage !== undefined && res.usage !== null) {
    onUsage?.({
      prompt_tokens: res.usage.prompt_tokens,
      completion_tokens: res.usage.completion_tokens,
    });
  }
  // ToS routing caveat (spec §3): a contributor model's output is never used.
  if (typeof res.model !== 'string' || /contributor/i.test(res.model)) {
    return { kind: 'contributor' };
  }
  const choice = res.choices[0];
  const content = choice?.message.content;
  if (choice === undefined || choice.finish_reason !== 'stop' || typeof content !== 'string') {
    return { kind: 'invalid' };
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { kind: 'invalid' };
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { kind: 'ok', value: parsed.data, model: res.model }
    : { kind: 'invalid' };
}

/** One retry on invalid output; a contributor model is never retried. */
async function completeWithRetry<T>(
  client: ChatClient,
  params: Params,
  schema: z.ZodType<T>,
  onUsage: MuseSparkOptions['onUsage'],
): Promise<Attempt<T>> {
  const first = await complete(client, params, schema, onUsage);
  if (first.kind !== 'invalid') return first;
  return complete(client, params, schema, onUsage);
}

function baseParams(model: string): Pick<Params, 'model' | 'reasoning_effort' | 'max_tokens'> {
  return { model, reasoning_effort: REASONING_EFFORT, max_tokens: MAX_TOKENS };
}

/* ---------------------------------------------------------------- reader */

function emptyToNull(s: string | null): string | null {
  return s === null || s.trim() === '' ? null : s;
}

function toExtractedLabel(m: ModelLabel): ExtractedLabel | null {
  const fields: LabelField[] = FieldKeySchema.options.map((key) => {
    const f = m.fields[key];
    return {
      key,
      value: emptyToNull(f.value),
      legibility: f.legibility,
      evidenceText: emptyToNull(f.evidenceText),
      imageIndex: null,
      notes: emptyToNull(f.notes),
    };
  });
  const parsed = ExtractedLabelSchema.safeParse({
    imageKind: m.imageKind,
    fields,
    rawText: m.rawText,
    warnings: m.warnings,
  });
  return parsed.success ? parsed.data : null;
}

export function createMuseSparkLabelReader(
  client: ChatClient,
  opts: MuseSparkOptions = {},
): LabelReader {
  const model = opts.model ?? MUSE_MODEL;
  return {
    async read(images: Buffer[], _ctx: ProviderContext): Promise<ReadResult> {
      if (images.length < 1 || images.length > MAX_IMAGES) {
        return { ok: false, code: 'OCR_FAILED', detail: 'bad_image_count' };
      }
      const params: Params = {
        ...baseParams(model),
        messages: [
          { role: 'system', content: READER_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: readerUserText(images.length) },
              ...images.map((img) => ({
                type: 'image_url' as const,
                image_url: { url: `data:image/jpeg;base64,${img.toString('base64')}` },
              })),
            ],
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'medicine_label', schema: LABEL_JSON_SCHEMA, strict: true },
        },
      };
      let attempt: Attempt<ModelLabel>;
      try {
        attempt = await completeWithRetry(client, params, ModelLabelSchema, opts.onUsage);
      } catch {
        return { ok: false, code: 'OCR_FAILED', detail: 'request_failed' };
      }
      if (attempt.kind === 'contributor') {
        return { ok: false, code: 'OCR_FAILED', detail: 'contributor_model' };
      }
      const label = attempt.kind === 'ok' ? toExtractedLabel(attempt.value) : null;
      if (attempt.kind !== 'ok' || label === null) {
        return { ok: false, code: 'OCR_FAILED', detail: 'invalid_output' };
      }
      return { ok: true, label, model: attempt.model };
    },
  };
}

/* -------------------------------------------------------------- answerer */

/**
 * Answers for questions the safety gate already allowed (the caller never
 * sends refused questions here). Every intent but explain_text is answered by
 * `answerFromLabel` with no model call, and so is an explain_text question
 * that names no printed phrase (the "What does this warning mean?" preset),
 * exactly as FixtureAnswerer does. For a printed phrase the model is sent only
 * the whole printed sentence around it (`explainQuote`), as JSON
 * {"phrase": ...}; its explanation is used only if `explanationAllowed`
 * passes, else the answer is the quote alone.
 */
export function createMuseSparkAnswerer(
  client: ChatClient,
  opts: MuseSparkOptions = {},
): QuestionAnswerer {
  const model = opts.model ?? MUSE_MODEL;
  return {
    async answer(input: AnswerInput, _ctx: ProviderContext): Promise<Answer> {
      if (input.intent !== 'explain_text') return answerFromLabel(input);
      const phrase = extractExplainPhrase(input.question);
      // Task 7b review round 1: a preset that names no phrase reads the printed
      // directions and warnings back, as in demo mode; no model call
      if (phrase === null) return answerFromLabel(input);
      // the whole printed sentence, never a fragment without its "Do not"
      const quote = explainQuote(phrase, input.label);
      if (quote === null) return unclearAnswer(PHRASE_NOT_FOUND_TEXT);

      const params: Params = {
        ...baseParams(model),
        messages: [
          { role: 'system', content: EXPLAIN_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ phrase: quote }) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'phrase_explanation',
            schema: EXPLANATION_JSON_SCHEMA,
            strict: true,
          },
        },
      };
      let attempt: Attempt<z.infer<typeof ModelExplanationSchema>>;
      try {
        attempt = await completeWithRetry(client, params, ModelExplanationSchema, opts.onUsage);
      } catch {
        return composeExplainAnswer(input, phrase, null);
      }
      // ToS routing caveat (spec §3): a contributor model aborts the request.
      if (attempt.kind === 'contributor') return unclearAnswer(ANSWER_FALLBACK_TEXT);
      const explanation =
        attempt.kind === 'ok' && explanationAllowed(attempt.value.explanation)
          ? attempt.value.explanation
          : null;
      return composeExplainAnswer(input, phrase, explanation);
    },
  };
}
