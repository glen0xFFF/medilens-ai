/**
 * Deterministic answers to questions the safety gate allowed (Task 7b
 * controller ruling). Every answer is built here from the scan's printed
 * fields and fixed sentences. The one model contribution is the explain_text
 * explanation: the server quotes the whole printed field around the asked
 * phrase verbatim (`explainQuote`), and adds a short model explanation of it
 * only when the field has no printed negation or condition and the
 * explanation is made of the closed vocabulary below (`explanationFits`). The
 * model never writes any other answer text.
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
import { ADVISORIES_UNCHECKED_NOTE, REG_NOT_FOUND_NOTE } from './matcher';
import { askedFields, type AllowedIntent } from './safety';
import {
  FINAL_LINE,
  LOOSE_PILL_SENTENCE,
  NOT_A_LABEL_SENTENCE,
  PARTLY_UNCLEAR,
  advisorySentence,
  verificationSentences,
} from './summary';

export const ANSWER_FALLBACK_TEXT = 'I can only answer from what is printed on the label.';
export const PHRASE_NOT_FOUND_TEXT = "I can't find that phrase on this label.";
export const NO_LABEL_TEXT = "I couldn't read this label, so I can't answer questions about it.";
const NO_EXPLANATION = "I can't explain this phrase further.";
const UNCERTAIN = 'Some of this was not clear on the pack, so it may be wrong.';
const NOTHING_READ = 'I could not read that on this label.';
const ALL_CLEAR = 'Every part I read on this label was clear.';

/** How each field is named when its printed value is read back ("Expiry date as printed: ..."). */
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
  expiryDate: 'Expiry date',
  batchNumber: 'Batch number',
  rxOrOtc: 'Prescription status',
};

/** Field names that take a plural verb ("The warnings on the label say ..."). */
const PLURAL_FIELDS: ReadonlySet<FieldKey> = new Set(['directions', 'warnings']);

/** A whole-label read: every field, in reading order (final review I3). */
const READ_KEYS: readonly FieldKey[] = [
  'brandName',
  'genericNames',
  'strength',
  'dosageForm',
  'manufacturer',
  'registrationNumber',
  'directions',
  'warnings',
  'storage',
  'expiryDate',
  'batchNumber',
  'rxOrOtc',
];

/** What an explain_text question that names no field or phrase reads back ("What does this mean?"). */
const EXPLAIN_KEYS: readonly FieldKey[] = ['directions', 'warnings'];

type ReadBackIntent = Exclude<AllowedIntent, 'registry' | 'unclear_parts'>;

/**
 * Fields read back for a question (final review I3): the field the question
 * names ("How should it be stored?" reads storage, "Who makes this
 * medicine?" the manufacturer), else the intent's default.
 */
function keysFor(intent: ReadBackIntent, question: string): readonly FieldKey[] {
  if (intent === 'strength') return ['strength'];
  const asked = askedFields(question);
  if (asked !== null) return asked;
  return intent === 'explain_text' ? EXPLAIN_KEYS : READ_KEYS;
}

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
  // one warning per conflicting field, the first registry value (final review Minor 6)
  const warned = new Set<FieldKey>();
  const warnings = match.conflicting
    .filter((c) => cited.includes(c.key) && !warned.has(c.key) && warned.add(c.key))
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
 * Final review I2: a scan that is not a readable medicine pack answers every
 * label question with the summary's own sentence, never a field value: a
 * loose tablet is never identified, even if the model filled fields from its
 * imprint. Null for a label.
 */
export function notALabelAnswer(label: ExtractedLabel): Answer | null {
  switch (label.imageKind) {
    case 'loose_pill':
      return unclearAnswer(LOOSE_PILL_SENTENCE);
    case 'not_medicine':
      return unclearAnswer(NOT_A_LABEL_SENTENCE);
    case 'unreadable':
      return unclearAnswer(NO_LABEL_TEXT);
    case 'label':
      return null;
  }
}

/**
 * Deterministic answer from the label fields of the scan, for every allowed
 * intent. Printed values are read back verbatim; nothing is inferred.
 */
export function answerFromLabel({ label, match, intent, question }: AnswerInput): Answer {
  const notALabel = notALabelAnswer(label);
  if (notALabel !== null) return notALabel;
  switch (intent) {
    case 'unclear_parts':
      return unclearParts(label.fields, match);
    case 'registry':
      return registryAnswer(label.fields, match);
    default:
      return readBack(label.fields, keysFor(intent, question), match);
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
  // the summary's own registry sentences and notes, in its order (final review Minor 6)
  const sentences = verificationSentences(match);
  for (const note of [REG_NOT_FOUND_NOTE, ADVISORIES_UNCHECKED_NOTE]) {
    if (match.limitations.includes(note)) sentences.push(note);
  }
  const advisory = advisorySentence(match.advisories);
  if (advisory !== null) sentences.push(advisory);
  return build(sentences, [key], f.legibility !== 'clear', match);
}

/**
 * Each printed value as its own sentence. A value that is not clear carries
 * the summary's marker before it (final review I1: "Strength as printed,
 * partly unclear: 500 mg."), so the listener knows which value may be wrong.
 */
function readBack(fields: LabelField[], keys: readonly FieldKey[], match: MatchAssessment): Answer {
  const sentences: string[] = [];
  const cited: FieldKey[] = [];
  let uncertain = false;
  for (const key of keys) {
    const f = fieldOf(fields, key);
    if (f === undefined) continue;
    cited.push(key);
    const value = (f.value ?? '').trim().replace(/\.+$/, '');
    const clear = f.legibility === 'clear';
    const name = `${FIELD_NAMES[key]} as printed${clear ? '' : `, ${PARTLY_UNCLEAR}`}`;
    sentences.push(`${name}: ${value}.`);
    if (!clear) uncertain = true;
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

/** A hit with where it sits in its field's collapsed printed value. */
interface LocatedHit extends PhraseHit {
  /** The field's printed value, whitespace runs collapsed. */
  value: string;
  start: number;
  end: number;
}

function locate(phrase: string, label: ExtractedLabel): LocatedHit[] {
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
  const hits: LocatedHit[] = [];
  for (const f of label.fields) {
    if (f.value === null) continue;
    const value = collapse(f.value);
    const m = pattern.exec(foldPunctuation(value));
    if (m === null) continue;
    const end = m.index + m[0].length;
    hits.push({
      key: f.key,
      printed: value.slice(m.index, end),
      legibility: f.legibility,
      value,
      start: m.index,
      end,
    });
  }
  return hits;
}

/**
 * Every field whose printed value contains `phrase`: case-insensitive, with
 * whitespace runs collapsed and typographic quotes matched as straight ones.
 * A phrase never matches part of a printed word ("ache" is not in
 * "headache"). Field values only, never rawText: the model is only ever asked
 * about text the scan transcribed into a field.
 */
export function findPhraseInFields(phrase: string, label: ExtractedLabel): PhraseHit[] {
  return locate(phrase, label).map(({ key, printed, legibility }) => ({
    key,
    printed,
    legibility,
  }));
}

/** The whole printed field value of a hit, without its end punctuation. */
function fieldQuote(hit: LocatedHit): string {
  const quote = hit.value.replace(/[.!?]+$/, '').trim();
  return quote === '' ? hit.printed : quote;
}

/**
 * What an explain_text answer quotes and the model is sent (Task 7b review
 * rounds 1 and 2, dropped context). Not the asked fragment and not its
 * sentence, but the whole printed value of the first field that prints it,
 * so a printed "Do not", heading or lead-in anywhere in the field is always
 * spoken. Null when the phrase is printed in no field.
 */
export function explainQuote(phrase: string, label: ExtractedLabel): string | null {
  const first = locate(phrase, label)[0];
  return first === undefined ? null : fieldQuote(first);
}

/* ------------------------------------------ explanation: closed vocabulary */

/*
 * Task 7b review round 2: the content gate is an allowlist. A word list of
 * what to reject did not converge (every review round found more), so an
 * explanation may now use only the words and the three phrase shapes below;
 * anything else is rejected. Every explanation the server can speak is built
 * from this finite vocabulary, which has no verb of taking, using, mixing,
 * applying or stopping, no "with", "for", "as" or "is", and no number, time,
 * amount, person, verdict, permission or medical-claim word. Its only
 * negation is "not" before a storage hazard, ending its sentence ("not hot or
 * damp"), and "need" only appears in "need a prescription", so neither can be
 * turned into its opposite. Over-rejection only costs the explanation; the
 * printed quote is still spoken.
 */

/** A topic of the vocabulary: used only when the printed text is about it. */
interface Topic {
  /** Matches the printed text (normalized, lowercase) when it is about this topic. */
  cue: RegExp;
  words: readonly string[];
  /** Fixed phrase shapes, each matched whole and ending its sentence. */
  phrases: readonly RegExp[];
}

/** Words with no topic: they say nothing on their own. */
// prettier-ignore
const GENERAL_WORDS: readonly string[] = [
  'a', 'an', 'and', 'bottle', 'in', 'it', 'its', 'means', 'or', 'the', 'this',
];

const HAZARD = '(?:hot|warm|damp|wet|humid|moist)';
const HAZARD_SOURCE =
  '(?:heat|(?:direct )?(?:sun)?light|(?:the )?sun|moisture|humidity|damp|steam)';
const AND_OR = '(?:,? (?:or|and) |, )';

/** A whole phrase shape: starts a word and ends its sentence. */
function shape(source: string): RegExp {
  return new RegExp(`(?<![a-z'])(?:${source})(?=[.!]|$)`, 'g');
}

/** "a", "a or b", "a, b and c". */
function listOf(item: string): string {
  return `${item}(?:${AND_OR}${item})*`;
}

const TOPICS: readonly Topic[] = [
  {
    // storage
    cue: /(?<![a-z])(?:stor(?:e|es|ed|ing|age)|keep|kept|protect[a-z]*|refrigerat[a-z]*)(?![a-z])/,
    // prettier-ignore
    words: [
      'closed', 'container', 'cool', 'dark', 'dry', 'keep', 'lid', 'place', 'shut', 'somewhere',
      'store', 'tightly',
    ],
    phrases: [
      // the only negation: "(that is) not hot or damp"
      shape(`(?:(?:that|which) is )?not ${listOf(HAZARD)}`),
      shape(`away from ${listOf(HAZARD_SOURCE)}`),
    ],
  },
  {
    // shaking
    cue: /(?<![a-z])shak(?:e|es|en|ing)(?![a-z])/,
    words: ['first', 'gently', 'shake', 'well'],
    phrases: [],
  },
  {
    // needing a prescription, never the reverse
    cue: /(?<![a-z])(?:prescri[a-z]*|rx|dispens[a-z]*)(?![a-z])/,
    words: [],
    phrases: [
      shape(
        "(?:you )?need a (?:doctor's )?prescription(?: from a doctor)?(?: to (?:buy|get) (?:it|this))?",
      ),
    ],
  },
];

/** Every single word an explanation may use, sorted; pinned by a test. */
export const EXPLANATION_WORDS: readonly string[] = [
  ...GENERAL_WORDS,
  ...TOPICS.flatMap((t) => t.words),
].sort();

const MAX_EXPLANATION_CHARS = 240;
const MAX_EXPLANATION_WORDS = 40;

/** Global constraint: never "fake" or "counterfeit" about the pack, inside any word too. */
const FAKE = /fake|counterfeit/;
const URL_OR_AT = /@|:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|gov|edu|ph|io|info|co|us|uk)\b/;
/** Lowercase ASCII letters, apostrophes, spaces and . , ! only. */
const OUTSIDE_ALPHABET = /[^a-z' .,!]/;

/** NFKC, invisible format characters removed, ASCII quotes and dashes, one line. */
function normalizeExplanation(text: string): string {
  return collapse(foldPunctuation(text.normalize('NFKC').replace(/\p{Cf}/gu, '')));
}

/**
 * The topics an explanation uses, or null when it is not inside the closed
 * vocabulary (or is empty, too long, or has a digit, a link or "fake").
 */
function explanationTopics(text: string): Set<Topic> | null {
  const t = normalizeExplanation(text).toLowerCase();
  if (t === '' || t.length > MAX_EXPLANATION_CHARS) return null;
  if (t.split(' ').length > MAX_EXPLANATION_WORDS) return null;
  if (/\p{Nd}/u.test(t) || FAKE.test(t) || URL_OR_AT.test(t) || OUTSIDE_ALPHABET.test(t)) {
    return null;
  }
  const used = new Set<Topic>();
  let rest = t;
  for (const topic of TOPICS) {
    for (const phrase of topic.phrases) {
      rest = rest.replace(phrase, () => {
        used.add(topic);
        return ' ';
      });
    }
  }
  for (const word of rest.split(/[ .,!]+/)) {
    if (word === '' || GENERAL_WORDS.includes(word)) continue;
    const topic = TOPICS.find((tp) => tp.words.includes(word));
    if (topic === undefined) return null;
    used.add(topic);
  }
  return used;
}

/**
 * Content gate for a model explanation: true only when every word is in the
 * closed vocabulary (`EXPLANATION_WORDS`, plus the "not hot or damp", "away
 * from heat" and "need a prescription" shapes), within 240 characters and 40
 * words, with no digit, link, "@", "fake" or "counterfeit". Over-rejection is
 * accepted: the fallback is the quote-only answer.
 */
export function explanationAllowed(text: string): boolean {
  return explanationTopics(text) !== null;
}

/**
 * Printed text the vocabulary cannot carry: a negation, condition, exception,
 * limit or group of people (finding 2 of review round 2 found negations
 * printed as a heading or lead-in). Over-inclusion only costs the explanation.
 */
// prettier-ignore
const NOT_EXPLAINED_WORDS = [
  // negation
  'not', 'no', 'never', 'nor', 'none', 'neither', 'nothing', 'nobody', 'nowhere', 'without',
  'cannot', "[a-z]*n't", 'dont', 'doesnt', 'didnt', 'cant', 'wont', 'shouldnt', 'mustnt', 'isnt',
  'arent', 'neednt', 'non[a-z]*',
  // sold without a prescription: "need a prescription" would be false
  'otc', 'counter',
  // condition, exception, limit
  'if', 'unless', 'except[a-z]*', 'until', 'till', 'but', 'however', 'otherwise', 'instead',
  'whether', 'when[a-z]*', 'while', 'whilst', 'provided', 'limit[a-z]*', 'exceed[a-z]*',
  'max[a-z]*', 'overdos[a-z]*',
  // stopping, avoiding, warning
  'avoid[a-z]*', 'stop[a-z]*', 'discontinu[a-z]*', 'discard[a-z]*', 'dispos[a-z]*',
  'prohibit[a-z]*', 'forbid[a-z]*', 'contraindicat[a-z]*', 'refrain[a-z]*', 'caution[a-z]*',
  'warn[a-z]*', 'beware', 'danger[a-z]*', 'consult[a-z]*',
  // groups of people
  'child[a-z]*', 'kids?', 'infants?', 'bab(?:y|ies)', 'toddlers?', 'adults?', 'elderly',
  'seniors?', 'teen[a-z]*', 'adolescen[a-z]*', 'pregnan[a-z]*', 'breast[ -]?fe[a-z]*', 'nursing',
  'lactat[a-z]*', 'patients?', 'persons?', 'people', 'years?', 'aged?',
];
const NOT_EXPLAINED = new RegExp(`(?<![a-z0-9])(?:${NOT_EXPLAINED_WORDS.join('|')})(?![a-z0-9])`);

/** Printed text as the cues see it: normalized, lowercase, one line. */
function printedForm(printed: string): string {
  return normalizeExplanation(printed).toLowerCase();
}

/**
 * Whether printed text may be explained by the model at all: it has no
 * negation, condition, exception, limit or group of people, and it is about
 * a topic the vocabulary covers (storage, shaking, a prescription). When this
 * is false the model is not called and the answer is the quote alone.
 */
export function quoteExplainable(printed: string): boolean {
  const p = printedForm(printed);
  return !NOT_EXPLAINED.test(p) && TOPICS.some((t) => t.cue.test(p));
}

/**
 * Whether a model explanation may be spoken after this printed quote: the
 * quote is explainable, the explanation passes `explanationAllowed`, and
 * every topic the explanation uses is one the printed text is about (no
 * storage advice after a dose, no prescription talk after a storage line).
 */
export function explanationFits(explanation: string, printed: string): boolean {
  const used = explanationTopics(explanation);
  // an explanation of general words only ("It means this.") says nothing
  if (used === null || used.size === 0 || !quoteExplainable(printed)) return false;
  const p = printedForm(printed);
  return [...used].every((topic) => topic.cue.test(p));
}

/* ------------------------------------------------------ explain answers */

/**
 * explain_text answer: the whole printed field around the phrase, quoted
 * verbatim from the first field that prints it (`explainQuote`), then the
 * explanation if it fits that quote (`explanationFits`), else a fixed
 * sentence. Answered even without an explanation: the quote is grounded.
 */
export function composeExplainAnswer(
  input: AnswerInput,
  phrase: string,
  explanation: string | null,
): Answer {
  const notALabel = notALabelAnswer(input.label);
  if (notALabel !== null) return notALabel;
  const hits = locate(phrase, input.label);
  const first = hits[0];
  if (first === undefined) return unclearAnswer(PHRASE_NOT_FOUND_TEXT);
  const printed = fieldQuote(first);
  const says = PLURAL_FIELDS.has(first.key) ? 'say' : 'says';
  const quote = `The ${FIELD_NAMES[first.key].toLowerCase()} on the label ${says} "${printed}".`;
  const plain =
    explanation !== null && explanationFits(explanation, printed)
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
