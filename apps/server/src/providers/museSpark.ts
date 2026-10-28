/**
 * Meta Muse Spark adapters (spec §4.2). The label reader only transcribes. The
 * answerer is deterministic for every intent but explain_text; for that one
 * the model sees only the printed field around the asked phrase and returns
 * a short explanation that the server gates against a closed vocabulary and
 * composes around a verbatim quote of that field (domain/answers.ts).
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
  explanationFits,
  quoteExplainable,
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

/** A failed model request as it may be logged: the error's class name and HTTP status only. */
export interface ModelRequestError {
  errorName: string;
  status: number | null;
}

export interface MuseSparkOptions {
  model?: string;
  /**
   * Called for every completion that returned, before its output is checked,
   * and with USAGE_ESTIMATE for a request that may have run but reported no
   * usage (final review Minor 11).
   */
  onUsage?: (usage: ModelUsage) => void;
  /** Called when a request fails, with no message text (final review Minor 12). */
  onError?: (error: ModelRequestError) => void;
}

export const MUSE_MODEL = 'muse-spark-1.3';
const META_BASE_URL = 'https://api.meta.ai/v1';
const MAX_TOKENS = 4000;
const REASONING_EFFORT = 'low';
const MAX_IMAGES = 3;

/**
 * Final review Minor 10: the client gives up before the app's own 60 s
 * timeout, and never retries on its own, so a slow read stops spending and
 * "Try again" is the only retry.
 */
export const META_TIMEOUT_MS = 45_000;
const META_MAX_RETRIES = 0;

/**
 * Final review Minor 11: what a call is charged when it reports no usage, so
 * the spend meter fails closed: the full prompt and completion budgets.
 */
export const USAGE_ESTIMATE: Readonly<ModelUsage> = {
  prompt_tokens: MAX_TOKENS,
  completion_tokens: MAX_TOKENS,
};

export { ANSWER_FALLBACK_TEXT, PHRASE_NOT_FOUND_TEXT };

/** The Meta Model API is OpenAI-compatible; only the chat completions surface is used. */
export function createMetaClient(apiKey: string): ChatClient {
  return new OpenAI({
    baseURL: META_BASE_URL,
    apiKey,
    timeout: META_TIMEOUT_MS,
    maxRetries: META_MAX_RETRIES,
  }).chat.completions;
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
/** A token count the API reported, or the estimate when it is missing or not a count. */
function counted(n: unknown, estimate: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : estimate;
}

/** The HTTP status of a client error, or null (a timeout or a connection error has none). */
function statusOf(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/**
 * One request. A request that throws is reported to onError by name and
 * status only (its message can echo request details), and is charged the
 * usage estimate unless a 4xx status shows it was refused before it ran.
 */
async function create(
  client: ChatClient,
  params: Params,
  opts: MuseSparkOptions,
): Promise<OpenAI.Chat.ChatCompletion> {
  try {
    return await client.create(params);
  } catch (err) {
    const status = statusOf(err);
    opts.onError?.({ errorName: err instanceof Error ? err.name : typeof err, status });
    if (status === null || status < 400 || status >= 500) opts.onUsage?.({ ...USAGE_ESTIMATE });
    throw err;
  }
}

async function complete<T>(
  client: ChatClient,
  params: Params,
  schema: z.ZodType<T>,
  opts: MuseSparkOptions,
): Promise<Attempt<T>> {
  const res = await create(client, params, opts);
  // final review Minor 11: a missing usage, or a missing count in it, is
  // charged the estimate, never zero
  const usage = res.usage as Partial<OpenAI.CompletionUsage> | null | undefined;
  opts.onUsage?.({
    prompt_tokens: counted(usage?.prompt_tokens, USAGE_ESTIMATE.prompt_tokens),
    completion_tokens: counted(usage?.completion_tokens, USAGE_ESTIMATE.completion_tokens),
  });
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
  opts: MuseSparkOptions,
): Promise<Attempt<T>> {
  const first = await complete(client, params, schema, opts);
  if (first.kind !== 'invalid') return first;
  return complete(client, params, schema, opts);
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
        attempt = await completeWithRetry(client, params, ModelLabelSchema, opts);
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
 * the whole printed field around it (`explainQuote`), as JSON
 * {"phrase": ...}, and only when that field has no printed negation or
 * condition and is about a topic the explanation vocabulary covers
 * (`quoteExplainable`); its explanation is used only if `explanationFits`
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
      // field it names back (answers.ts), as in demo mode; no model call
      if (phrase === null) return answerFromLabel(input);
      // the whole printed field, never a fragment without its "Do not"
      const quote = explainQuote(phrase, input.label);
      if (quote === null) return unclearAnswer(PHRASE_NOT_FOUND_TEXT);
      // Task 7b review round 2: printed text with a negation or condition, or
      // that no explanation could fit, is never sent: the quote alone, no call
      if (!quoteExplainable(quote)) return composeExplainAnswer(input, phrase, null);

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
        attempt = await completeWithRetry(client, params, ModelExplanationSchema, opts);
      } catch {
        return composeExplainAnswer(input, phrase, null);
      }
      // ToS routing caveat (spec §3): a contributor model aborts the request.
      if (attempt.kind === 'contributor') return unclearAnswer(ANSWER_FALLBACK_TEXT);
      const explanation =
        attempt.kind === 'ok' && explanationFits(attempt.value.explanation, quote)
          ? attempt.value.explanation
          : null;
      return composeExplainAnswer(input, phrase, explanation);
    },
  };
}
