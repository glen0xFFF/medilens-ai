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

/* ------------------------------------------- answer grounding post-checks */

const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  once: '1',
  two: '2',
  twice: '2',
  three: '3',
  thrice: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  sixty: '60',
  seventy: '70',
  eighty: '80',
  ninety: '90',
  hundred: '100',
  thousand: '1000',
  half: '1/2',
  quarter: '1/4',
};

/** Month names; "may" is left out because it is mostly the verb. */
const MONTHS = [
  ['january', 'jan'],
  ['february', 'feb'],
  ['march', 'mar'],
  ['april', 'apr'],
  ['june', 'jun'],
  ['july', 'jul'],
  ['august', 'aug'],
  ['september', 'sep', 'sept'],
  ['october', 'oct'],
  ['november', 'nov'],
  ['december', 'dec'],
] as const;

// A number followed by a dose, count or time unit ("500 mg", "2 tablets", "6 hours").
const NUMBER_UNIT_RE =
  /(\d+(?:[.,]\d+)*)\s*-?\s*(micrograms?|milligrams?|grams?|mcg|µg|ug|mg|kg|g|ml|l|iu|units?|%|°c|tablets?|capsules?|caplets?|drops?|teaspoons?|tablespoons?|sachets?|puffs?|sprays?|patch(?:es)?|hours?|hrs?|days?|weeks?|minutes?|mins?)(?![\p{L}\p{N}])/giu;

function words(s: string): string[] {
  const f = fold(s);
  return f === '' ? [] : f.split(' ');
}

/** Every number in the text: digit runs plus spelled-out numbers, as digit strings. */
const NUMBER_RE = /\d+(?:[.,]\d+)*/g;
const FRACTION_RE = /\d+(?:[.,]\d+)*(?:\/\d+(?:[.,]\d+)*)+/g;

function spelledNumbers(s: string): string[] {
  return words(s).flatMap((w) => NUMBER_WORDS[w] ?? []);
}

/**
 * Every number in the text as a digit string: digit runs, slash groups
 * ("1/2", "12/2027") and spelled-out numbers ("twice" is "2", "half" is "1/2").
 */
function numberTokens(s: string): Set<string> {
  const n = s.normalize('NFKC');
  return new Set([
    ...(n.match(NUMBER_RE) ?? []),
    ...(n.match(FRACTION_RE) ?? []),
    ...spelledNumbers(s),
  ]);
}

function unitKey(u: string): string {
  const l = u.toLowerCase();
  if (l === 'µg' || l === 'ug' || l.startsWith('microgram')) return 'mcg';
  if (l.startsWith('milligram')) return 'mg';
  if (l.startsWith('gram')) return 'g';
  if (l.startsWith('hr')) return 'hour';
  if (l.startsWith('min')) return 'minute';
  if (l.startsWith('patch')) return 'patch';
  return l.length > 2 && l.endsWith('s') ? l.slice(0, -1) : l;
}

function numberUnitPairs(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.normalize('NFKC').matchAll(NUMBER_UNIT_RE)) {
    out.add(`${m[1] ?? ''}${unitKey(m[2] ?? '')}`);
  }
  return out;
}

function monthsIn(s: string): (typeof MONTHS)[number][] {
  const ws = new Set(words(s));
  return MONTHS.filter((names) => names.some((n) => ws.has(n)));
}

/**
 * Finding 2 (review round 1): every number, number-with-unit and month the
 * answer states must be printed in a field it cites. Otherwise the model said
 * something the evidence does not support (a wrong dose, a guessed date).
 */
function ungroundedFigures(text: string, evidence: string[]): boolean {
  const nums = new Set(evidence.flatMap((e) => [...numberTokens(e)]));
  // A fraction or date is grounded only as a whole ("half" needs a printed
  // "half" or "1/2", not a "1" and a "2" from different places).
  const stated = [...(text.normalize('NFKC').match(FRACTION_RE) ?? []), ...spelledNumbers(text)];
  const plain = text.normalize('NFKC').replace(FRACTION_RE, ' ').match(NUMBER_RE) ?? [];
  if (![...stated, ...plain].every((n) => nums.has(n))) return true;
  const pairs = new Set(evidence.flatMap((e) => [...numberUnitPairs(e)]));
  for (const p of numberUnitPairs(text)) {
    if (!pairs.has(p)) return true;
  }
  const printed = new Set(evidence.flatMap(words));
  if (monthsIn(text).some((names) => !names.some((n) => printed.has(n)))) return true;
  return ungroundedFrequency(text, evidence);
}

/* Dose frequency, grounded as a whole expression (review round 2). */

const FREQ_WORD_CANON: Record<string, string> = {
  once: '1 times',
  twice: '2 times',
  thrice: '3 times',
  time: 'times',
  hours: 'hour',
  hrs: 'hour',
  hr: 'hour',
  days: 'day',
  weeks: 'week',
  minutes: 'minute',
  mins: 'minute',
  min: 'minute',
  hourly: 'per hour',
  daily: 'per day',
  weekly: 'per week',
};

/** Folded text with spelled numbers as digits and every way of saying "per day" as "per day". */
function frequencyCanon(s: string): string {
  const ws = words(s).map((w) => {
    const n = NUMBER_WORDS[w];
    if (n !== undefined && !n.includes('/') && FREQ_WORD_CANON[w] === undefined) return n;
    return FREQ_WORD_CANON[w] ?? w;
  });
  return ` ${ws.join(' ')} `
    .replace(/ (?:a|an|each|every|per) (hour|day|week)(?= )/g, ' per $1')
    .replace(/ (\d+) (?:to|or) (\d+)(?= )/g, ' $1 $2');
}

// Greedy, so "3 times per day" is one expression and never matches a printed "per day" alone.
const FREQUENCY_RE =
  /(?<= )(?:every other (?:hour|day|week)|every \d+(?: \d+)? (?:minute|hour|day|week)|(?:\d+(?: \d+)? times )?per (?:hour|day|week)|\d+(?: \d+)? times)(?= )/g;

function frequencies(s: string): Set<string> {
  return new Set(frequencyCanon(s).match(FREQUENCY_RE) ?? []);
}

/**
 * Every frequency the answer states ("every hour", "hourly", "6 times a day",
 * "twice daily") must be printed, as the same whole expression, in a cited
 * field. A bare number check lets the 6 in "every 4 to 6 hours" ground "6
 * times a day".
 */
function ungroundedFrequency(text: string, evidence: string[]): boolean {
  const printed = new Set(evidence.flatMap((e) => [...frequencies(e)]));
  return [...frequencies(text)].some((f) => !printed.has(f));
}

/**
 * Clinical-claim screen. Each pattern is matched against the folded answer; a
 * hit is allowed only in the context a cited field prints it in (see
 * unsupportedClaim), for example "Keep out of reach of children" in the warnings.
 */
const CLINICAL_TERMS = [
  String.raw`safe(?:ly|r|st|ty)?`,
  'harmless',
  'harmful',
  'dangerous',
  String.raw`risk\w*`,
  String.raw`child(?:ren)?`,
  String.raw`kids?`,
  String.raw`infants?`,
  String.raw`bab(?:y|ies)`,
  String.raw`pa?ediatric\w*`,
  'elderly',
  String.raw`seniors?`,
  String.raw`pregnan\w*`,
  String.raw`breast ?fe\w*`,
  'nursing',
  String.raw`lactat\w*`,
  String.raw`interact\w*`,
  String.raw`alcohol\w*`,
  'food',
  String.raw`drinks?`,
  String.raw`other (?:medicines?|medications?|drugs?)`,
  String.raw`combin\w*`,
  'together',
  'more',
  'extra',
  'double',
  String.raw`increas\w*`,
  String.raw`exceed\w*`,
  'as many',
  'as much',
  String.raw`overdos\w*`,
  'should',
  String.raw`recommend\w*`,
  String.raw`advi[cs]e\w*`,
  'okay',
  'ok',
  'fine',
  'suitable',
  'allowed',
  String.raw`stop\w*`,
  String.raw`start\w*`,
  String.raw`switch\w*`,
  String.raw`diagnos\w*`,
  String.raw`symptoms?`,
  String.raw`treat\w*`,
  String.raw`cur(?:e|es|ed|ing)`,
  String.raw`heal\w*`,
  'genuine',
  'authentic',
  String.raw`legit\w*`,
  'real',
  'verified',
  'approved',
  // Registry status (review round 4): only in its printed context. "registration
  // number" of a cited registrationNumber is reduced to "number" before this check.
  String.raw`regist\w*`,
  // Indication and efficacy (review round 2).
  'good for',
  'used for',
  String.raw`help(?:s|ed|ing|ful)?`,
  String.raw`reliev\w*`,
  'relief',
  String.raw`pain\w*`,
  String.raw`aches?`,
  String.raw`fevers?`,
  String.raw`headaches?`,
  String.raw`works?`,
  'working',
  String.raw`effective\w*`,
  'useful',
  String.raw`indicat\w*`,
  String.raw`colds?`,
  'flu',
  String.raw`infections?`,
];
const CLINICAL_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${CLINICAL_TERMS.join('|')})(?![\\p{L}\\p{N}])`,
  'gu',
);

/** Words that turn a statement around ("do not", "don't", "never", "avoid"). */
const NEGATIONS = new Set(['not', 'no', 'never', 'avoid', 'cannot', 'nor', 'without', 't']);
const CONTEXT_WORDS = 2;

/**
 * Folded clauses as word lists. A clause ends at punctuation followed by a
 * space (so "2.5 mg" stays whole); a negation never reaches across one.
 */
function clauses(s: string): string[][] {
  return s
    .normalize('NFKC')
    .split(/[.;:!?,](?=\s|$)|\n/)
    .map((c) => words(c))
    .filter((c) => c.length > 0);
}

/** A line that ends a sentence or already ends in a colon ("Adults:"). */
const LINE_END_RE = /[.;:!?]$/;

/**
 * Review round 5: printed text with its line breaks removed, because a reader
 * transcribes a dosing table or a wrapped line with newlines and a newline does
 * not end a printed sentence. A break after ". ; : ! ?" becomes a space. A break
 * after any other line becomes `glue`. The printed-sentence check passes ": ",
 * so a heading ("Children 6 to 12 years") stays joined to the dose under it and a
 * wrapped "Do not exceed" stays joined to its amount. The round-2 screen passes
 * " ", so a wrapped negation keeps its scope there.
 */
function joinPrintedLines(s: string, glue: ': ' | ' '): string {
  return s
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .reduce((out, line) => {
      if (out === '') return line;
      return `${out}${LINE_END_RE.test(out) ? ' ' : glue}${line}`;
    }, '');
}

/** True when a negation comes before word i in its clause. */
function negatedAt(ws: string[], i: number): boolean {
  return ws.slice(0, i).some((w) => NEGATIONS.has(w));
}

/** Start indexes of `needle` as a run of whole words in `hay`. */
function wordRunAt(hay: string[], needle: string[]): number[] {
  const out: number[] = [];
  for (let p = 0; p + needle.length <= hay.length; p++) {
    if (needle.every((w, k) => hay[p + k] === w)) out.push(p);
  }
  return out;
}

/**
 * Review round 2: a screened term is allowed only in the context the label
 * prints it in. The term with up to two words either side must be printed as
 * the same run of words in a cited field, and a negation earlier in the
 * clause must be there in both or in neither. So "keep out of reach of children" is
 * allowed, but "children take 1 tablet too", "you can exceed the stated dose"
 * and "take it with alcohol" are not.
 */
function unsupportedClaim(text: string, evidence: string[]): boolean {
  const printed = evidence.flatMap((e) => clauses(joinPrintedLines(e, ' ')));
  for (const ws of clauses(text)) {
    const folded = ws.join(' ');
    for (const m of folded.matchAll(CLINICAL_RE)) {
      const start = folded.slice(0, m.index).split(' ').length - 1;
      const end = start + m[0].split(' ').length; // exclusive
      const from = Math.max(0, start - CONTEXT_WORDS);
      const window = ws.slice(from, Math.min(ws.length, end + CONTEXT_WORDS));
      const negated = negatedAt(ws, start);
      const supported = printed.some((ev) =>
        wordRunAt(ev, window).some((p) => negatedAt(ev, p + (start - from)) === negated),
      );
      if (!supported) return true;
    }
  }
  return false;
}

/** Words that show an answer is about a field even when it cites another one. */
const FIELD_TOPICS: Record<FieldKey, string[]> = {
  brandName: ['brand', 'brand name'],
  genericNames: [String.raw`generic\w*`, String.raw`ingredients?`],
  strength: ['strength', 'mg', 'mcg', 'micrograms?', 'milligrams?', 'grams?', 'ml', 'iu'],
  dosageForm: ['dosage form', 'form'],
  manufacturer: [String.raw`manufactur\w*`, 'made by', 'maker', 'company'],
  registrationNumber: ['registration', String.raw`registered`, 'dr'],
  directions: [String.raw`directions?`, 'dose', 'dosage'],
  warnings: [String.raw`warnings?`, String.raw`cautions?`],
  storage: [String.raw`stor(?:e|ed|age|ing)`, 'temperature'],
  expiryDate: [String.raw`expir\w*`, 'exp', 'use by', 'best before'],
  batchNumber: ['batch', 'lot'],
  rxOrOtc: ['prescription', 'rx', 'otc', 'over the counter'],
};

function mentionsTopic(foldedText: string, key: FieldKey): boolean {
  const re = new RegExp(`(?:^| )(?:${FIELD_TOPICS[key].join('|')})(?= |$)`);
  return re.test(foldedText);
}

/**
 * Finding 1 (review round 1), spec §4.3 rule 4: decided from what the answer
 * says, not from what it cites. An answer is about a field that is not clear
 * when it cites it, when the intent asks for it, when it names the field, or
 * when it repeats the field's printed value, any of its numbers or (review
 * round 2) any of its content words, so a mis-cited paraphrase is caught.
 */
function aboutUnclearField(
  text: string,
  intent: string,
  cited: Set<FieldKey>,
  label: ExtractedLabel,
): boolean {
  const unclearFields = label.fields.filter((f) => f.legibility !== 'clear');
  if (unclearFields.length === 0) return false;
  if (intent === 'unclear_parts') return true;
  const folded = fold(text);
  const padded = ` ${folded} `;
  const nums = numberTokens(text);
  const content = contentTerms(text);
  return unclearFields.some((f) => {
    if (cited.has(f.key)) return true;
    if (intent === 'strength' && f.key === 'strength') return true;
    if (mentionsTopic(folded, f.key)) return true;
    return [f.value, f.evidenceText].some((v) => {
      if (v === null) return false;
      const fv = fold(v);
      if (fv !== '' && padded.includes(` ${fv} `)) return true;
      if ([...numberTokens(v)].some((n) => nums.has(n))) return true;
      // Review round 2: a paraphrase shares content words even when it is not verbatim.
      return [...contentTerms(v)].some((t) => content.has(t));
    });
  });
}

/** Function words and answer framing that say nothing about a field's content. */
const STOP_WORDS = new Set(
  (
    'a an the of to in on at by for from with and or nor if is it its be been being are was were ' +
    'as do does did done not no this that these those there their they them then than when what ' +
    'which where who whom whose why how you your yours we our us he she his her i me my can could ' +
    'will would shall should may might must have has had having into onto over under about after ' +
    'before also only just very each some such any all more most other so too up out off s t ' +
    'label labels pack package packet box printed print says say said reads read shows show ' +
    'written text part parts unclear clear words word phrase means mean meaning medicine product ' +
    'here states stated'
  ).split(' '),
);

/**
 * Content terms of a text: each non-stop word of 4 or more letters, and each
 * pair of consecutive folded words of which at least one is not a stop word.
 */
function contentTerms(s: string): Set<string> {
  const ws = words(s);
  const out = new Set<string>();
  ws.forEach((w, i) => {
    if (!STOP_WORDS.has(w) && /^\p{L}{4,}$/u.test(w)) out.add(w);
    const next = ws[i + 1];
    if (next !== undefined && (!STOP_WORDS.has(w) || !STOP_WORDS.has(next))) {
      out.add(`${w} ${next}`);
    }
  });
  return out;
}

/* ------------------------- vocabulary grounding and polarity (review round 3) */

/**
 * Words that carry no claim of their own: articles, pronouns, auxiliaries and
 * plain prepositions. Modals (can, may, must, should), quantifiers (more,
 * another, few), directional words (out, within, below, after) and population
 * words (anyone, people) are NOT here: they change what an answer claims, so
 * they must be printed.
 */
const FUNCTION_WORDS = new Set(
  (
    'a an the of to in on at by for from with as and or if than then that which who whom whose ' +
    'what when where how there here it its this these those you your yours yourself they them ' +
    'their he him his she her we us our i me my is are was were be been being am do does did ' +
    'has have had having every each per s re ll ve d m'
  ).split(' '),
);

/** Words that turn a statement around. Grounded by the polarity check, not by vocabulary. */
const GROUND_NEGATIONS = new Set([...NEGATIONS, 'none', 'neither']);

/**
 * Answer framing allowed without being printed: how an answer refers to the
 * label and its fields ("the warnings printed on the pack say"). None of these
 * words states a medication fact on its own. Review round 4:
 * - Registry and prescription status words (registered, registration,
 *   prescription, rx, otc) and maker words are not here. Status words must be
 *   printed in a cited field. FIELD_FRAMING and REGISTRATION_NUMBER_RE hold the
 *   exceptions that apply only when their field is cited.
 * - "take", "dose" and "dosage" pass this vocabulary check, but
 *   brokenPrintedSentence allows them only inside a restated printed sentence,
 *   or "take" directly before a printed dose. So "Take 500 mg" and "The dose is
 *   500 mg" (the strength, restated as a dose) fail.
 */
const FRAMING_WORDS =
  'label labels pack package packet box carton printed print prints say says said read reads ' +
  'state states show shows written text word words phrase mean means meaning take takes taking ' +
  'medicine product field section brand name generic ingredient ingredients active strength form ' +
  'dosage dose number direction directions instruction instructions warning warnings caution ' +
  'cautions storage store stored expiry expiration expire expires exp date batch lot unclear ' +
  'clear part partly partial partially readable unreadable legible';

/**
 * Review round 4: words that are framing only when their own field is cited
 * with a value ("The manufacturer is ..." citing manufacturer).
 */
const FIELD_FRAMING: Partial<Record<FieldKey, string[]>> = {
  manufacturer: ['manufacturer', 'manufactured', 'made', 'maker', 'company'],
};

/**
 * Review round 4: "registration" is framing only as the field name
 * "registration number" (or "registration no."), and only when the
 * registration number is cited. "is registered" and "the registration is
 * clear" state a registry status, which comes from MatchAssessment, never from
 * the model.
 */
const REGISTRATION_NUMBER_RE = /\bregistration\s+(?:number\b|no\.)/giu;

/** "dosage form" names the field; on its own "dosage" states an amount (see DOSE_STEMS). */
const DOSAGE_FORM_RE = /\bdosage\s+forms?\b/giu;

/** Answer text with field-name phrases of cited fields reduced to plain framing. */
function withFieldNames(text: string, cited: Set<FieldKey>): string {
  let out = text;
  if (cited.has('registrationNumber')) out = out.replace(REGISTRATION_NUMBER_RE, 'number');
  if (cited.has('dosageForm')) out = out.replace(DOSAGE_FORM_RE, 'form');
  return out;
}

/** Stems of the field-gated framing words whose field is cited. */
function citedFraming(cited: Set<FieldKey>): Set<string> {
  return new Set([...cited].flatMap((k) => FIELD_FRAMING[k] ?? []).map(stem));
}

/** Same-meaning frequency adverbs folded to the noun the label may print instead. */
const WORD_CANON: Record<string, string> = {
  hourly: 'hour',
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  nightly: 'night',
};

const VOWEL = /[aeiouy]/;

/** Light stem so plurals, -ed and -ing forms match ("taking" and "take", "doses" and "dose"). */
function stem(word: string): string {
  let s = WORD_CANON[word] ?? word;
  if (s.length > 4 && s.endsWith('ies')) s = `${s.slice(0, -3)}y`;
  else if (s.length > 3 && s.endsWith('s') && !/(?:ss|us|is)$/.test(s)) s = s.slice(0, -1);
  if (s.length > 4 && s.endsWith('ing') && VOWEL.test(s.slice(0, -3))) s = s.slice(0, -3);
  else if (s.length > 3 && s.endsWith('ed') && !s.endsWith('eed') && VOWEL.test(s.slice(0, -2))) {
    s = s.slice(0, -2);
  }
  if (/([b-df-hj-np-tv-z])\1$/.test(s) && !/(?:ll|ss|zz)$/.test(s)) s = s.slice(0, -1);
  if (s.length > 2 && s.endsWith('e') && !s.endsWith('ee')) s = s.slice(0, -1);
  return s;
}

const FRAMING = new Set(FRAMING_WORDS.split(' ').map(stem));

/** "don't" is "do not", "can't" is "cannot", so a contraction is a negation, not a word. */
function expandContractions(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/\bcan['’]t\b/gi, 'cannot')
    .replace(/\bwon['’]t\b/gi, 'will not')
    .replace(/n['’]t\b/gi, ' not');
}

function isNumberWord(w: string): boolean {
  return /^\p{N}+$/u.test(w) || NUMBER_WORDS[w] !== undefined;
}

/** A content token: a folded word that is not a function word, negation or number. */
function isContent(w: string): boolean {
  return !FUNCTION_WORDS.has(w) && !GROUND_NEGATIONS.has(w) && !isNumberWord(w);
}

/**
 * Review round 3, finding 2 (1): every content word of the answer must be
 * printed in a field it cites, apart from the small framing allowlist. Numbers
 * are left to ungroundedFigures. This grounds vocabulary instead of screening
 * listed terms, so "every couple of hours", "teenagers", "toothache" and a
 * mis-cited paraphrase ("keep it somewhere cool") all fail the same way.
 */
function ungroundedWords(text: string, evidence: string[], framing: Set<string>): boolean {
  const printed = new Set(evidence.flatMap((e) => words(expandContractions(e)).map(stem)));
  return words(expandContractions(text))
    .filter(isContent)
    .map(stem)
    .some((w) => !FRAMING.has(w) && !framing.has(w) && !printed.has(w));
}

/* ------------------------------ printed sentences restated whole (review round 4) */

/** Fields whose sentences are instructions or a status: restated whole or not at all. */
const CLAUSE_FIELDS = new Set<FieldKey>(['directions', 'warnings', 'storage', 'rxOrOtc']);

/** Function words that carry dosing meaning, so they stay in the compared sequence. */
const KEPT_FUNCTION_WORDS = new Set(['every', 'each', 'per', 'and', 'or']);
const KEPT_STEMS = new Set([...KEPT_FUNCTION_WORDS].map(stem));

/** The colon of a printed "Adults: 1 tablet", kept as a token so "take" may stand in for it. */
const COLON = ':';

const TAKE_STEMS = new Set(['take', 'takes', 'taking'].map(stem));

/** "dose" and "dosage" state an amount, so an answer says them only inside a printed sentence. */
const DOSE_STEMS = new Set(['dose', 'doses', 'dosage', 'dosing'].map(stem));

const NEGATION_STEMS = new Set([...GROUND_NEGATIONS].map(stem));

/** Legibility words a negation may describe without a printed source ("is not clear"). */
const LEGIBILITY_STEMS = new Set(['clear', 'readable', 'legible'].map(stem));

/**
 * Review round 5: population and condition words (the CLINICAL_TERMS
 * population entries, plus "adult" and close synonyms), matched on stems.
 */
const POPULATION_RE =
  /^(?:adult|child|children|kid|infan\w*|baby|toddler|newborn|neonat\w*|teen\w*|adolescen\w*|pa?ediatric|elder\w*|senior|geriatric|pregnan\w*|breast\w*|nurs\w*|lactat\w*|mother|women|woman)$/u;

function isPopulation(token: string): boolean {
  return POPULATION_RE.test(token);
}

/** Age and weight words a dosing-table heading may hold ("Children 6 to 12 years", "aged 12 and over"). */
const HEADING_STEMS = new Set(
  (
    'year years yr yrs month months week weeks age aged ages old older younger over under above ' +
    'below up upward upwards plus weighing weigh weight kg body and or'
  )
    .split(' ')
    .map(stem),
);

/**
 * True when the printed tokens before the colon at `colon` (back to the
 * previous colon or the sentence start) are a heading: population, age or
 * weight words and numbers only ("Adults", "Children 6 to 12 years").
 */
function headingBefore(p: string[], colon: number): boolean {
  let k = colon - 1;
  if (k < 0) return false;
  for (; k >= 0; k--) {
    const t = p[k];
    if (t === undefined || t === COLON) break;
    if (!isPopulation(t) && !isNumberWord(t) && !HEADING_STEMS.has(t)) return false;
  }
  return k < colon - 1;
}

// "1/2" and "1/4" as words, so a printed "1/2 tablet" and a stated "half a tablet" compare equal.
const HALF_RE = /(?<![\d/.,])1\s*\/\s*2(?![\d/])/g;
const QUARTER_RE = /(?<![\d/.,])1\s*\/\s*4(?![\d/])/g;

function partTokens(part: string): string[] {
  return frequencyCanon(part.replace(HALF_RE, ' half ').replace(QUARTER_RE, ' quarter '))
    .split(' ')
    .filter((w) => w !== '' && (!FUNCTION_WORDS.has(w) || KEPT_FUNCTION_WORDS.has(w)))
    .map(stem);
}

/**
 * Sentences as compared token sequences. Only a sentence end splits (". ; ! ?"
 * before a space, or a newline): a colon or comma never separates a printed
 * population or condition from its instruction. Printed text goes through
 * joinPrintedLines first (review round 5), so for it a newline never splits;
 * answer text still splits at a newline. Tokens are folded with
 * contractions expanded, numbers and frequencies made canonical ("twice
 * daily" and "2 times a day" are both "2 times per day"), stemmed, and plain
 * function words (articles, pronouns, auxiliaries, prepositions) dropped.
 * Negations, numbers, "every", "each", "per", "and", "or" and a colon are kept.
 */
function sentenceTokens(s: string): string[][] {
  return expandContractions(s)
    .split(/[.;!?](?=\s|$)|\n/)
    .map((sentence) =>
      sentence
        .split(/:(?=\s|$)/)
        .map(partTokens)
        .filter((t) => t.length > 0)
        .flatMap((t, k) => (k === 0 ? t : [COLON, ...t])),
    )
    .filter((t) => t.length > 0);
}

/**
 * End (exclusive) of a copy of printed sentence `p` in answer sentence `a`
 * starting at a[start], or -1. Every printed token must appear, in order, with
 * nothing in between except an answer colon. A printed colon may be left out.
 * When a number follows it and a heading comes before it, one "take" may stand
 * in for it ("Adults take 1 tablet" for "Adults: 1 tablet"). Review round 5:
 * only after a heading, so a printed limit never becomes an instruction ("Do
 * not exceed, take 8 tablets" for "Do not exceed: 8 tablets"). No other word
 * can be inserted, so "take" never starts a new instruction inside a printed
 * sentence.
 */
function copyEnd(a: string[], p: string[], start: number): number {
  let i = start;
  for (let j = 0; j < p.length; j++) {
    if (j > 0 && a[i] === COLON) i++;
    const want = p[j];
    if (want === COLON) {
      const tok = a[i];
      const next = p[j + 1];
      if (
        tok !== undefined &&
        TAKE_STEMS.has(tok) &&
        next !== undefined &&
        isNumberWord(next) &&
        headingBefore(p, j)
      ) {
        i++;
      }
      continue;
    }
    if (a[i] !== want) return -1;
    i++;
  }
  return i;
}

/**
 * Review round 4, finding 2: a printed instruction is restated whole or not at
 * all. In each answer sentence, every token that a cited directions, warnings,
 * storage or prescription-status sentence prints must lie inside a complete,
 * in-order copy of some cited printed sentence (of any cited field). Here a
 * token is any number and any content word that is not answer framing.
 * Outside the copies:
 * - a negation breaks the answer, unless it describes legibility ("is not
 *   clear") with a legibility word that is not itself part of a printed copy;
 * - "dose" or "dosage" breaks it, so the strength is never restated as a dose;
 * - "take" breaks it, unless a copy of a printed directions sentence that
 *   starts with a number follows ("Take 1 tablet ..." for "1 tablet ...").
 * Otherwise an answer sentence may hold only framing, function words and words
 * that ungroundedWords finds printed in another cited field. So an extra
 * "not", a dropped "out" or "Protect from", a negation moved across "?" or ",",
 * a dropped condition, and a printed population joined to another sentence's
 * dose all fail. This replaces the round-3 run-and-window polarity rule.
 *
 * Review round 5:
 * - Printed line breaks are joined first (joinPrintedLines), so a table heading
 *   and its dose, or a wrapped "Do not exceed" and its amount, form one printed
 *   sentence. Answer text still splits at a newline.
 * - A population word is anchored wherever it is printed, so "Kids" taken out of
 *   a cited brand name ("Paracelin Kids") fails like "children" taken out of a
 *   warning. See populationJoinedToDose and doseGivenNewHeading for the other
 *   two rules.
 */
function brokenPrintedSentence(text: string, cited: LabelField[]): boolean {
  const sources: PrintedSentence[] = cited.flatMap((f) =>
    sentenceTokens(joinPrintedLines(f.value ?? '', ': ')).map((tokens, idx) => ({
      key: f.key,
      idx,
      tokens,
    })),
  );
  const anchored = new Set([
    ...sources
      .filter((src) => CLAUSE_FIELDS.has(src.key))
      .flatMap((src) => src.tokens)
      .filter(
        (t) => t !== COLON && !FRAMING.has(t) && !NEGATION_STEMS.has(t) && !KEPT_STEMS.has(t),
      ),
    ...sources.flatMap((src) => src.tokens).filter(isPopulation),
  ]);
  return sentenceTokens(text).some((a) => brokenAnswerSentence(a, sources, anchored));
}

/** One printed sentence of a cited field, with its position in that field. */
interface PrintedSentence {
  key: FieldKey;
  idx: number;
  tokens: string[];
}

/** A complete copy of a printed sentence inside an answer sentence, at a[start..end). */
interface Copy extends PrintedSentence {
  start: number;
  end: number;
}

function copiesIn(a: string[], sources: PrintedSentence[]): Copy[] {
  const out: Copy[] = [];
  for (const src of sources) {
    for (let s = 0; s < a.length; s++) {
      if (a[s] !== src.tokens[0]) continue;
      const end = copyEnd(a, src.tokens, s);
      if (end >= 0) out.push({ ...src, start: s, end });
    }
  }
  return out;
}

/** A printed dose or limit: a directions sentence, or a warnings sentence with a number. */
function holdsDose(c: PrintedSentence): boolean {
  return c.key === 'directions' || (c.key === 'warnings' && c.tokens.some(isNumberWord));
}

function brokenAnswerSentence(
  a: string[],
  sources: PrintedSentence[],
  anchored: Set<string>,
): boolean {
  const copies = copiesIn(a, sources);
  const inCopy = (i: number, which: (c: Copy) => boolean = () => true) =>
    copies.some((c) => c.start <= i && i < c.end && which(c));
  const doseCopyAt = (i: number) =>
    copies.some(
      (c) => c.start === i && c.key === 'directions' && isNumberWord(c.tokens[0] ?? ''),
    );
  for (let i = 0; i < a.length; i++) {
    const tok = a[i];
    if (tok === undefined || inCopy(i)) continue;
    if (NEGATION_STEMS.has(tok)) {
      // "is not clear" describes legibility; "Do not clear nasal passages" negates a printed sentence.
      if (!LEGIBILITY_STEMS.has(a[i + 1] ?? '') || inCopy(i + 1)) return true;
      continue;
    }
    if (anchored.has(tok) || DOSE_STEMS.has(tok)) return true;
    if (TAKE_STEMS.has(tok) && !doseCopyAt(i + 1)) return true;
  }
  return populationJoinedToDose(a, copies, inCopy) || doseGivenNewHeading(copies);
}

/**
 * Review round 5, finding 2 (B): in an answer sentence that restates a printed
 * dose or limit, every population word must lie inside a copy of a directions,
 * warnings, storage or prescription-status sentence. A copy of the brand name,
 * generic name or manufacturer alone never grounds it, so "Paracelin Kids: 1
 * tablet every 4 to 6 hours" fails.
 */
function populationJoinedToDose(
  a: string[],
  copies: Copy[],
  inCopy: (i: number, which?: (c: Copy) => boolean) => boolean,
): boolean {
  if (!copies.some(holdsDose)) return false;
  return a.some((t, i) => isPopulation(t) && !inCopy(i, (c) => CLAUSE_FIELDS.has(c.key)));
}

/**
 * Review round 5, finding 2 (A): a printed dose or limit that has no population
 * word of its own ("2 tablets every 6 hours.") keeps the heading it is printed
 * under. In one answer sentence, the copy directly before it must be the
 * sentence printed directly before it in the same field. So a reader
 * transcription that ends each table line with a period ("Children 6 to 12
 * years. 1 tablet every 6 hours.") cannot be re-paired ("Children 6 to 12
 * years: 2 tablets every 6 hours."), and another sentence cannot become its
 * heading ("Keep out of reach of children: 1 tablet ...").
 */
function doseGivenNewHeading(copies: Copy[]): boolean {
  return copies.some((c) => {
    const bare =
      (c.key === 'directions' || c.key === 'warnings') &&
      c.tokens.some(isNumberWord) &&
      !c.tokens.some(isPopulation);
    if (!bare) return false;
    const before = copies.filter((o) => o !== c && o.end <= c.start);
    if (before.length === 0) return false;
    const last = Math.max(...before.map((o) => o.end));
    return !before.some((o) => o.end === last && o.key === c.key && o.idx === c.idx - 1);
  });
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

function checkAnswer(out: ModelAnswer, { label, match, intent }: AnswerInput): Answer {
  const text = out.text.trim();
  const cited = [...new Set(out.citedFields)];
  const withValue = new Set(label.fields.filter(hasValue).map((f) => f.key));
  if (text === '' || cited.length === 0 || !cited.every((k) => withValue.has(k))) {
    return unclear(ANSWER_FALLBACK_TEXT);
  }
  if (claimsFake(text, match)) return unclear(ANSWER_FALLBACK_TEXT);

  const citedSet = new Set<FieldKey>(cited);
  const citedFields = label.fields.filter((f) => citedSet.has(f.key));
  const evidence = citedFields.map((f) => f.value ?? '');
  // The fixed advisory sentence is deterministic text, not a claim to ground.
  const stated = match.advisories.length > 0 ? text.split(ADVISORY_SENTENCE).join(' ') : text;
  const claim = withFieldNames(stated, citedSet);
  if (
    ungroundedFigures(claim, evidence) ||
    unsupportedClaim(claim, evidence) ||
    ungroundedWords(claim, evidence, citedFraming(citedSet)) ||
    brokenPrintedSentence(claim, citedFields)
  ) {
    return unclear(ANSWER_FALLBACK_TEXT);
  }

  const notices = match.conflicting
    .filter((c) => citedSet.has(c.key))
    .map((c) => conflictWarning(c.key, c.referenceValue));
  if (aboutUnclearField(text, intent, citedSet, label)) notices.push(ANSWER_UNCERTAIN_SENTENCE);

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
