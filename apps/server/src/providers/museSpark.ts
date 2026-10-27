/**
 * Meta Muse Spark adapters (spec §4.2). The label reader only transcribes; the
 * answerer only restates the scan's evidence, and deterministic post-checks
 * decide whether its answer may be spoken. No env access here: the HTTP layer
 * builds the client and passes it in.
 */
import {
  ExtractedLabelSchema,
  FieldKeySchema,
  ImageKindSchema,
  LegibilitySchema,
  type Answer,
  type ExtractedLabel,
  type FieldKey,
  type LabelField,
  type MatchAssessment,
} from '@medilens/contracts';
import OpenAI from 'openai';
import { z } from 'zod';
import { extractExplainPhrase } from '../domain/safety';
import { ADVISORY_SENTENCE, FINAL_LINE } from '../domain/summary';
import { conflictWarning } from './fixture';
import { ANSWERER_SYSTEM_PROMPT, READER_SYSTEM_PROMPT, readerUserText } from './prompts';
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

export const ANSWER_FALLBACK_TEXT = 'I can only answer from what is printed on the label.';
export const ANSWER_UNCERTAIN_SENTENCE = 'Part of this was unclear on the label.';
export const PHRASE_NOT_FOUND_TEXT = "I can't find that phrase on this label.";

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

const ModelAnswerSchema = z.object({
  text: z.string(),
  citedFields: z.array(FieldKeySchema),
});
type ModelAnswer = z.infer<typeof ModelAnswerSchema>;

/** Strict-mode JSON Schema: every field inlined (no $ref), nullable as ["string","null"]. */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: 'draft-7', io: 'output', reused: 'inline' });
  const { $schema: _drop, ...rest } = out as Record<string, unknown>;
  return rest;
}

const LABEL_JSON_SCHEMA = jsonSchema(ModelLabelSchema);
const ANSWER_JSON_SCHEMA = jsonSchema(ModelAnswerSchema);

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

function unclear(text: string): Answer {
  return {
    status: 'unclear',
    text,
    spokenChunks: [text, FINAL_LINE],
    citedFields: [],
    safetyNotice: null,
  };
}

function hasValue(f: LabelField): boolean {
  return f.value !== null && f.value.trim() !== '';
}

/** Case-, punctuation- and whitespace-insensitive form for phrase lookup. */
function fold(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** True when the phrase occurs, as whole words, in a transcribed value or the raw text. */
function phraseOnLabel(phrase: string, label: ExtractedLabel): boolean {
  const needle = fold(phrase);
  if (needle === '') return false;
  const sources = [...label.fields.filter(hasValue).map((f) => f.value ?? ''), label.rawText];
  return sources.some((s) => ` ${fold(s)} `.includes(` ${needle} `));
}

/**
 * Global constraint: the app never calls the user's pack fake or counterfeit,
 * except the fixed advisory sentence, and that only when the registry check
 * actually returned an advisory.
 */
function claimsFake(text: string, match: MatchAssessment): boolean {
  const rest = match.advisories.length > 0 ? text.split(ADVISORY_SENTENCE).join(' ') : text;
  const probe = rest.normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '');
  return /fake|counterfeit/i.test(probe);
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Evidence sent to the model: printed fields and the registry outcome; no image, no registry rows. */
function evidenceJson({ label, match, question, intent }: AnswerInput): string {
  return JSON.stringify({
    question,
    intent,
    fields: label.fields.map(({ key, value, legibility }) => ({ key, value, legibility })),
    match: {
      status: match.status,
      matched: match.matched,
      conflicting: match.conflicting,
      missing: match.missing,
      hasAdvisory: match.advisories.length > 0,
      limitations: match.limitations,
    },
  });
}

function checkAnswer(out: ModelAnswer, { label, match }: AnswerInput): Answer {
  const text = out.text.trim();
  const cited = [...new Set(out.citedFields)];
  const withValue = new Set(label.fields.filter(hasValue).map((f) => f.key));
  if (text === '' || cited.length === 0 || !cited.every((k) => withValue.has(k))) {
    return unclear(ANSWER_FALLBACK_TEXT);
  }
  if (claimsFake(text, match)) return unclear(ANSWER_FALLBACK_TEXT);

  const citedSet = new Set<FieldKey>(cited);
  const notices = match.conflicting
    .filter((c) => citedSet.has(c.key))
    .map((c) => conflictWarning(c.key, c.referenceValue));
  const uncertain = label.fields.some((f) => citedSet.has(f.key) && f.legibility !== 'clear');
  if (uncertain) notices.push(ANSWER_UNCERTAIN_SENTENCE);

  const all = [...sentences(text), ...notices];
  return {
    status: 'answered',
    text: [text, ...notices].join(' '),
    spokenChunks: [...all, FINAL_LINE],
    citedFields: cited,
    safetyNotice: notices.length > 0 ? notices.join(' ') : null,
  };
}

/**
 * Grounded answers for questions the safety gate already allowed (the caller
 * never sends refused questions here). Client errors propagate to the caller.
 */
export function createMuseSparkAnswerer(
  client: ChatClient,
  opts: MuseSparkOptions = {},
): QuestionAnswerer {
  const model = opts.model ?? MUSE_MODEL;
  return {
    async answer(input: AnswerInput, _ctx: ProviderContext): Promise<Answer> {
      // Controller ruling (Task 5b breaker): explain only phrases printed on this label.
      if (input.intent === 'explain_text') {
        const phrase = extractExplainPhrase(input.question);
        if (phrase !== null && !phraseOnLabel(phrase, input.label)) {
          return unclear(PHRASE_NOT_FOUND_TEXT);
        }
      }
      const params: Params = {
        ...baseParams(model),
        messages: [
          { role: 'system', content: ANSWERER_SYSTEM_PROMPT },
          { role: 'user', content: evidenceJson(input) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'label_answer', schema: ANSWER_JSON_SCHEMA, strict: true },
        },
      };
      const attempt = await completeWithRetry(client, params, ModelAnswerSchema, opts.onUsage);
      if (attempt.kind !== 'ok') return unclear(ANSWER_FALLBACK_TEXT);
      return checkAnswer(attempt.value, input);
    },
  };
}
