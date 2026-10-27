/**
 * Deterministic answers to questions the safety gate allowed (Task 7b
 * controller ruling). Every answer is built here from the scan's printed
 * fields and fixed sentences. The one model contribution is the explain_text
 * explanation: the server quotes the printed phrase verbatim, and adds a short
 * model explanation only when it passes `explanationAllowed`. The model never
 * writes any other answer text.
 */
import type {
  Answer,
  ExtractedLabel,
  FieldKey,
  LabelField,
  Legibility,
  MatchAssessment,
} from '@medilens/contracts';
import type { AnswerInput } from '../providers/types';
import type { AllowedIntent } from './safety';
import { ADVISORY_SENTENCE, FINAL_LINE, verificationSentences } from './summary';

export const ANSWER_FALLBACK_TEXT = 'I can only answer from what is printed on the label.';
export const PHRASE_NOT_FOUND_TEXT = "I can't find that phrase on this label.";
const NO_EXPLANATION = "I can't explain this phrase further.";
const UNCERTAIN = 'Some of this was not clear on the pack, so it may be wrong.';
const NOTHING_READ = 'I could not read that on this label.';
const ALL_CLEAR = 'Every part I read on this label was clear.';
const REGISTRY_NOT_CHECKED = 'The FDA registry was not checked.';

export const FIELD_NAMES: Record<FieldKey, string> = {
  brandName: 'Brand name',
  genericNames: 'Generic name',
  strength: 'Strength',
  dosageForm: 'Dosage form',
  manufacturer: 'Manufacturer',
  registrationNumber: 'Registration number',
  directions: 'Directions',
  warnings: 'Warnings',
  storage: 'Storage',
  expiryDate: 'Expiry date printed on the pack',
  batchNumber: 'Batch number',
  rxOrOtc: 'Prescription status',
};

const READ_KEYS: readonly FieldKey[] = [
  'brandName',
  'genericNames',
  'strength',
  'dosageForm',
  'manufacturer',
  'directions',
  'warnings',
  'storage',
  'expiryDate',
];

/** Fields read back per intent; registry and unclear_parts have their own branches. */
const KEYS_BY_INTENT: Record<
  Exclude<AllowedIntent, 'registry' | 'unclear_parts'>,
  readonly FieldKey[]
> = {
  strength: ['strength'],
  explain_text: ['directions', 'warnings'],
  read_label: READ_KEYS,
  other_label: READ_KEYS,
};

/** The registry answer cites the first of these the scan printed. */
const REGISTRY_KEYS: readonly FieldKey[] = [
  'registrationNumber',
  'brandName',
  'genericNames',
  'strength',
];

/* ------------------------------------------------------------- building */

function hasValue(f: LabelField): boolean {
  return f.value !== null && f.value.trim() !== '';
}

function fieldOf(fields: LabelField[], key: FieldKey): LabelField | undefined {
  return fields.find((f) => f.key === key && hasValue(f));
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** A fixed non-answer: nothing is cited, and the final confirm line is still spoken. */
export function unclearAnswer(text: string): Answer {
  return {
    status: 'unclear',
    text,
    spokenChunks: [text, FINAL_LINE],
    citedFields: [],
    safetyNotice: null,
  };
}

/**
 * Fixed warning for a cited field the FDA registry record contradicts
 * (spec §5.3 rule 6): the printed value is never read back as certain.
 */
export function conflictWarning(key: FieldKey, referenceValue: string): string {
  const ref = referenceValue.trim().replace(/\.+$/, '');
  return `The FDA registry record lists ${ref} for the ${FIELD_NAMES[key].toLowerCase()}, which does not match the pack. Confirm with your pharmacist.`;
}

/**
 * The answer around `sentences`: conflict warnings for cited fields, the
 * uncertain sentence, and the final confirm line last.
 */
function build(
  sentences: string[],
  cited: FieldKey[],
  uncertain: boolean,
  match: MatchAssessment,
): Answer {
  if (sentences.length === 0) return unclearAnswer(NOTHING_READ);
  const warnings = match.conflicting
    .filter((c) => cited.includes(c.key))
    .map((c) => conflictWarning(c.key, c.referenceValue));
  const notices = uncertain ? [...warnings, UNCERTAIN] : warnings;
  const all = [...sentences, ...notices];
  return {
    status: 'answered',
    text: all.join(' '),
    spokenChunks: [...all, FINAL_LINE],
    citedFields: cited,
    safetyNotice: notices.length > 0 ? notices.join(' ') : null,
  };
}

/* -------------------------------------------------------- label answers */

/**
 * Deterministic answer from the label fields of the scan, for every allowed
 * intent. Printed values are read back verbatim; nothing is inferred.
 */
export function answerFromLabel({ label, match, intent }: AnswerInput): Answer {
  switch (intent) {
    case 'unclear_parts':
      return unclearParts(label.fields, match);
    case 'registry':
      return registryAnswer(label.fields, match);
    default:
      return readBack(label.fields, KEYS_BY_INTENT[intent], match);
  }
}

function unclearParts(fields: LabelField[], match: MatchAssessment): Answer {
  const unclear = fields.filter((f) => f.legibility !== 'clear');
  if (unclear.length === 0) {
    const read = READ_KEYS.filter((k) => fieldOf(fields, k) !== undefined);
    if (read.length === 0) return unclearAnswer(NOTHING_READ);
    return build([ALL_CLEAR], read, false, match);
  }
  const names = unclear.map((f) => FIELD_NAMES[f.key].toLowerCase()).join(', ');
  // an unreadable field with no value is named, but there is no value to cite
  const cited = unique(unclear.filter(hasValue).map((f) => f.key));
  return build([`These parts were not clear on the pack: ${names}.`], cited, true, match);
}

/** The registry outcome in the spoken summary's own sentences (summary.ts). */
function registryAnswer(fields: LabelField[], match: MatchAssessment): Answer {
  const key = REGISTRY_KEYS.find((k) => fieldOf(fields, k) !== undefined);
  const f = key === undefined ? undefined : fieldOf(fields, key);
  if (key === undefined || f === undefined) return unclearAnswer(NOTHING_READ);
  const sentences =
    match.status === 'not_attempted' ? [REGISTRY_NOT_CHECKED] : verificationSentences(match);
  if (match.advisories.length > 0) sentences.push(ADVISORY_SENTENCE);
  return build(sentences, [key], f.legibility !== 'clear', match);
}

function readBack(fields: LabelField[], keys: readonly FieldKey[], match: MatchAssessment): Answer {
  const sentences: string[] = [];
  const cited: FieldKey[] = [];
  let uncertain = false;
  for (const key of keys) {
    const f = fieldOf(fields, key);
    if (f === undefined) continue;
    cited.push(key);
    const value = (f.value ?? '').trim().replace(/\.+$/, '');
    sentences.push(`${FIELD_NAMES[key]} as printed: ${value}.`);
    if (f.legibility !== 'clear') uncertain = true;
  }
  return build(sentences, cited, uncertain, match);
}

/* ------------------------------------------------------ printed phrases */

export interface PhraseHit {
  key: FieldKey;
  /** The phrase exactly as printed (original case), whitespace runs collapsed. */
  printed: string;
  legibility: Legibility;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Typographic quotes and dashes to ASCII, one UTF-16 unit for one, so indices are kept. */
function foldPunctuation(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201B\u2032`]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Every field whose printed value contains `phrase`: case-insensitive, with
 * whitespace runs collapsed and typographic quotes matched as straight ones.
 * A phrase never matches part of a printed word ("ache" is not in
 * "headache"). Field values only, never rawText: the model is only ever asked
 * about text the scan transcribed into a field.
 */
export function findPhraseInFields(phrase: string, label: ExtractedLabel): PhraseHit[] {
  const needle = foldPunctuation(collapse(phrase));
  const chars = [...needle];
  const first = chars[0];
  const last = chars.at(-1);
  if (first === undefined || last === undefined) return [];
  const pattern = new RegExp(
    (WORD_CHAR.test(first) ? '(?<![\\p{L}\\p{N}])' : '') +
      escapeRegExp(needle) +
      (WORD_CHAR.test(last) ? '(?![\\p{L}\\p{N}])' : ''),
    'iu',
  );
  const hits: PhraseHit[] = [];
  for (const f of label.fields) {
    if (f.value === null) continue;
    const printed = collapse(f.value);
    const m = pattern.exec(foldPunctuation(printed));
    if (m === null) continue;
    hits.push({
      key: f.key,
      printed: printed.slice(m.index, m.index + m[0].length),
      legibility: f.legibility,
    });
  }
  return hits;
}

/* ------------------------------------------------- explanation content gate */

const MAX_EXPLANATION_CHARS = 240;
const MAX_EXPLANATION_WORDS = 40;

// prettier-ignore
const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundreds?', 'thousands?', 'half', 'halves', 'quarters?', 'once', 'twice', 'thrice',
  'doubles?', 'single', 'dozens?',
];

// prettier-ignore
const UNIT_AND_DOSE_WORDS = [
  'mg', 'mcg', '\u00B5g', '\u03BCg', 'g', 'grams?', 'mls?', 'millilit(?:er|re)s?', 'l',
  'lit(?:er|re)s?', 'iu', 'tablets?', 'tabs?', 'capsules?', 'caps?', 'pills?', 'drops?',
  'puffs?', '(?:tea|table)?spoons?(?:ful|fuls)?', 'sachets?', 'doses?', 'dosage', 'dosing',
  'hours?', 'hourly', 'days?', 'daily', 'weeks?', 'weekly', 'months?', 'monthly',
  'mornings?', 'evenings?', 'afternoons?', 'noon', 'nights?', 'nightly', 'overnight',
  'midnight', 'bedtimes?', 'minutes?', 'maximum', 'max', 'minimum', 'exceed\\p{L}*',
  'overdos\\p{L}*',
];

// prettier-ignore
const POPULATION_WORDS = [
  'child', 'children', 'kids?', 'infants?', 'newborns?', 'baby', 'babies', 'toddlers?',
  'adults?', 'grown-?ups?', 'elderly', 'older', 'elders?', 'seniors?', 'teens?', 'teenagers?',
  'adolescents?', 'junior', 'jr', 'pediatric', 'paediatric', 'pregnan\\p{L}*',
  'breast[ -]?fe\\p{L}*', 'nursing', 'lactat\\p{L}*', 'patients?', 'years?', 'ages?', 'aged',
  'weigh\\p{L}*', 'kg',
];

// prettier-ignore
const VERDICT_AND_ADVICE_WORDS = [
  'genuine', 'authentic', 'safe', 'safely', 'safer', 'safest', 'safety', 'unsafe', 'danger',
  'dangerous', 'harmless', 'harmful', 'registered', 'approved', 'recommend\\p{L}*',
  'should\\p{L}*', 'must\\p{L}*', 'take', 'takes', 'taken', 'taking', 'took',
  'stop(?:s|ped|ping)?', 'start(?:s|ed|ing)?', 'avoid(?:s|ed|ing)?', 'cure(?:s|d)?', 'curing',
  'treat\\p{L}*',
];

/**
 * Not in the Task 7b brief's lists: indications, interactions and suitability
 * (spec §4.3), which a phrase such as a generic name invites. Over-rejection
 * only costs the explanation; the quote is still spoken.
 */
// prettier-ignore
const MEDICAL_CLAIM_WORDS = [
  'pains?', 'painful', 'fevers?', 'feverish', '(?:head|tooth|stomach|back)?aches?', 'relie\\p{L}*',
  'infection\\p{L}*', 'symptom\\p{L}*', 'diseases?', 'illness(?:es)?', 'cough\\p{L}*', 'flu',
  'allerg\\p{L}*', 'side[ -]effects?', 'alcohol\\p{L}*', 'combin\\p{L}*', 'interact\\p{L}*',
  'fine', 'ok', 'okay', 'alright', 'harms?', 'risk\\p{L}*', 'suitab\\p{L}*', 'young\\p{L}*',
];

const BLOCKED_WORD = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[
    ...NUMBER_WORDS,
    ...UNIT_AND_DOSE_WORDS,
    ...POPULATION_WORDS,
    ...VERDICT_AND_ADVICE_WORDS,
    ...MEDICAL_CLAIM_WORDS,
  ].join('|')})(?![\\p{L}\\p{N}])`,
  'u',
);

/** Global constraint: never "fake" or "counterfeit" about the pack, inside any word too. */
const FAKE = /fake|counterfeit/;
const URL_OR_AT = /@|:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|gov|edu|ph|io|info|co|us|uk)\b/;
const NOT_PLAIN_ASCII = /[^\x20-\x7E]/;

/** NFKC, invisible format characters removed, ASCII quotes and dashes, one line. */
function normalizeExplanation(text: string): string {
  return collapse(foldPunctuation(text.normalize('NFKC').replace(/\p{Cf}/gu, '')));
}

/**
 * Content gate for a model explanation of a printed phrase. It rejects any
 * number, amount, unit, time, frequency, group of people, verdict or advice
 * word, link, and anything that is not one short line of plain English.
 * Over-rejection is accepted: the fallback is the quote-only answer.
 */
export function explanationAllowed(text: string): boolean {
  const t = normalizeExplanation(text).toLowerCase();
  if (t === '' || t.length > MAX_EXPLANATION_CHARS) return false;
  if (t.split(' ').length > MAX_EXPLANATION_WORDS) return false;
  if (NOT_PLAIN_ASCII.test(t) || /\p{Nd}/u.test(t)) return false;
  return !FAKE.test(t) && !BLOCKED_WORD.test(t) && !URL_OR_AT.test(t);
}

/* ------------------------------------------------------ explain answers */

/**
 * explain_text answer: the printed phrase quoted verbatim from the first field
 * that prints it, then the explanation if it passes the gate, else a fixed
 * sentence. Answered even without an explanation: the quote is grounded.
 */
export function composeExplainAnswer(
  input: AnswerInput,
  phrase: string,
  explanation: string | null,
): Answer {
  const hits = findPhraseInFields(phrase, input.label);
  const first = hits[0];
  if (first === undefined) return unclearAnswer(PHRASE_NOT_FOUND_TEXT);
  const quote = `The ${FIELD_NAMES[first.key].toLowerCase()} on the label says "${first.printed}".`;
  const plain =
    explanation !== null && explanationAllowed(explanation)
      ? normalizeExplanation(explanation)
      : null;
  const second =
    plain === null
      ? NO_EXPLANATION
      : `In plain words: ${/[.!?]$/.test(plain) ? plain : `${plain}.`}`;
  return build(
    [quote, second],
    unique(hits.map((h) => h.key)),
    hits.some((h) => h.legibility !== 'clear'),
    input.match,
  );
}
