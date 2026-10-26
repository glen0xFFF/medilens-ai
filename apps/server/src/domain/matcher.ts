/**
 * Deterministic label-to-registry matcher (spec §5.4). It decides the
 * verification status the app speaks aloud, so every rule here errs towards
 * the weaker status: a field that cannot be read or parsed is `missing`,
 * never `matched` and never `conflicting`.
 */
import type {
  ExtractedLabel,
  FieldConflict,
  FieldKey,
  LabelField,
  MatchAssessment,
  ReferenceRecord,
} from '@medilens/contracts';
import type { ReferenceSearchResult } from '../providers/types';
import {
  DOSAGE_FORM_MODIFIERS,
  DOSAGE_FORM_WORDS,
  DROPS_QUALIFIERS,
  normalizeName,
  normalizeRegistrationNumber,
  parseStrength,
  strengthsEqual,
} from './parsers';

const EXPIRY_NOTE = "Registration expiry is not the product's expiry date.";
const UNAVAILABLE_NOTE = 'Registry lookup unavailable; nothing was verified.';
const NOT_ATTEMPTED_NOTE = 'Registry lookup was not attempted.';
export const REG_NOT_FOUND_NOTE = 'The registration number on the pack was not found in the registry.';

/** The label fields the matcher compares, in the order they are reported. */
const COMPARED: readonly FieldKey[] = [
  'registrationNumber',
  'brandName',
  'genericNames',
  'strength',
  'dosageForm',
];

type Outcome = 'matched' | 'conflict' | 'missing';

interface Evaluation {
  record: ReferenceRecord;
  outcomes: Map<FieldKey, Outcome>;
  conflicts: FieldConflict[];
  /** Number of fields that matched; ties between fitting records are ambiguous (rule 7). */
  score: number;
  /** Brand or generic name matched (rule 5). */
  nameMatched: boolean;
  /** A stated dosage form could not be confirmed; at most `partial`. */
  formBlocksVerified: boolean;
}

/**
 * The value of a label field, or null when it is absent, unreadable or not
 * `clear` (rule 10). A key that appears more than once is not comparable.
 */
function clearValue(label: ExtractedLabel, key: FieldKey): string | null {
  const found: LabelField[] = label.fields.filter((f) => f.key === key);
  if (found.length !== 1) return null;
  const [field] = found;
  if (field === undefined || field.legibility !== 'clear' || field.value === null) return null;
  return field.value.trim() === '' ? null : field.value;
}

/** Splits a list of ingredient names on `+`, `,` or the word `and`. */
function nameSet(s: string): Set<string> {
  return new Set(
    s
      .split(/\+|,|\band\b/i)
      .map(normalizeName)
      .filter((n) => n !== ''),
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** True when the words of `inner` appear as a contiguous run of whole words in `outer`. */
function containsWords(outer: string, inner: string): boolean {
  const o = outer.split(' ');
  const i = inner.split(' ');
  for (let start = 0; start + i.length <= o.length; start++) {
    if (i.every((w, k) => o[start + k] === w)) return true;
  }
  return false;
}

function compareBrand(labelValue: string, referenceValue: string): Outcome {
  const a = normalizeName(labelValue);
  const b = normalizeName(referenceValue);
  if (a === '' || b === '') return 'missing';
  return a === b || containsWords(a, b) || containsWords(b, a) ? 'matched' : 'conflict';
}

function compareGeneric(labelValue: string, referenceValue: string): Outcome {
  const a = nameSet(labelValue);
  const b = nameSet(referenceValue);
  if (a.size === 0 || b.size === 0) return 'missing';
  return setsEqual(a, b) ? 'matched' : 'conflict';
}

/**
 * Registry `strengthForm` is free text such as `500 mg Tablet`. Dropping the
 * dosage-form words (the list `normalizeName` uses) leaves the strength part.
 * A null parse on either side means "not comparable".
 */
function compareStrength(labelValue: string, strengthForm: string): Outcome {
  const a = parseStrength(labelValue);
  const b = parseStrength(normalizeName(strengthForm));
  if (a === null || b === null) return 'missing';
  return strengthsEqual(a, b) ? 'matched' : 'conflict';
}

/** Units skipped when looking for form text in `500 mg/5 mL Suspension`. */
const UNIT_WORDS = new Set([
  'mg',
  'mcg',
  'μg',
  'ug',
  'g',
  'gram',
  'grams',
  'milligram',
  'milligrams',
  'microgram',
  'micrograms',
  'ml',
  'l',
  'iu',
]);
/** Standalone words that belong to a strength or pack size, not to a form. */
const STRENGTH_WORDS = new Set([...UNIT_WORDS, 'per', 'x']);
/** A number glued to a unit, such as `500mg` or `5ml`: a pure strength token. */
const GLUED_STRENGTH = /^\p{N}+(\p{L}+)$/u;
/** `Film Coated`, `Film–Coated` and `Film—Coated` are all spelled `film-coated`. */
const FILM_COATED = /film[\s\p{Pd}]*coated/gu;

/**
 * Splits free text into lower-case words. A hyphen-glued token that is not
 * itself a vocabulary word (`500mg-capsule`) is split at its hyphens, so the
 * form is still seen. Numbers, units and glued strengths are dropped. Any
 * other word that mixes letters and digits (`capsule500`, `10s`) is kept,
 * so it counts as unrecognised.
 */
function formWords(text: string): string[] {
  const words: string[] = [];
  const tokens = text.normalize('NFKC').toLowerCase().replace(FILM_COATED, 'film-coated');
  for (const token of tokens.split(/[^\p{L}\p{N}-]+/u)) {
    const parts = isVocabulary(token) ? [token] : token.split('-');
    for (const part of parts) {
      if (!/\p{L}/u.test(part) || STRENGTH_WORDS.has(part)) continue;
      const glued = GLUED_STRENGTH.exec(part);
      if (glued !== null && UNIT_WORDS.has(glued[1] ?? '')) continue;
      words.push(part);
    }
  }
  return words;
}

const isVocabulary = (word: string) =>
  formOf(word) !== undefined || DOSAGE_FORM_MODIFIERS.has(word);

interface FormReading {
  /** Canonical forms named, e.g. `tablet`, `eye drops`. */
  forms: Set<string>;
  /** Some word is neither a form word, a modifier nor part of the strength. */
  unrecognised: boolean;
}

/**
 * Reads the form words in free text using the shared vocabulary in
 * parsers.ts. Returns null when the text holds no form text at all (only
 * numbers and strength units, such as `500 mg`).
 */
function readForm(text: string): FormReading | null {
  const words = formWords(text);
  if (words.length === 0) return null;
  const forms = new Set<string>();
  // A format character (zero-width space, soft hyphen) is never stripped silently.
  let unrecognised = /\p{Cf}/u.test(text);
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    if (DOSAGE_FORM_MODIFIERS.has(word)) continue;
    const next = words[i + 1];
    if (DROPS_QUALIFIERS.has(word) && next !== undefined && formOf(next) === 'drops') {
      forms.add(`${word} drops`);
      i++;
      continue;
    }
    const form = formOf(word);
    if (form === undefined) unrecognised = true;
    else forms.add(form);
  }
  return { forms, unrecognised };
}

const formOf = (word: string): string | undefined =>
  Object.hasOwn(DOSAGE_FORM_WORDS, word) ? DOSAGE_FORM_WORDS[word] : undefined;

interface FormComparison {
  outcome: Outcome;
  /** The form could not be confirmed although it was stated, so `verified` is out of reach. */
  blocksVerified: boolean;
}

/**
 * Dosage form, label `dosageForm` against the form text in `strengthForm`.
 * - Both sides name recognised forms and the forms differ: conflict.
 * - The registry text has no form text at all, or the label states no form:
 *   `missing`, and `verified` stays reachable (spec rule 3).
 * - Any other doubt (an unclear label value, a word we do not recognise such
 *   as `Effervescent` or `Pessary`): `missing`, capped at `partial`.
 */
function compareDosageForm(label: ExtractedLabel, record: ReferenceRecord): FormComparison {
  const stated = label.fields.some(
    (f) => f.key === 'dosageForm' && f.value !== null && f.value.trim() !== '',
  );
  if (!stated) return { outcome: 'missing', blocksVerified: false };
  const ref = record.strengthForm === null ? null : readForm(record.strengthForm);
  if (ref === null) return { outcome: 'missing', blocksVerified: false };
  const labelValue = clearValue(label, 'dosageForm');
  const lab = labelValue === null ? null : readForm(labelValue);
  if (lab === null) return { outcome: 'missing', blocksVerified: true };
  if (lab.forms.size > 0 && ref.forms.size > 0 && !setsEqual(lab.forms, ref.forms)) {
    return { outcome: 'conflict', blocksVerified: true };
  }
  if (lab.unrecognised || ref.unrecognised || lab.forms.size === 0 || ref.forms.size === 0) {
    return { outcome: 'missing', blocksVerified: true };
  }
  return { outcome: 'matched', blocksVerified: false };
}

const COMPARATORS: readonly [
  FieldKey,
  (record: ReferenceRecord) => string | null,
  (labelValue: string, ref: string) => Outcome,
][] = [
  ['brandName', (r) => r.brandName, compareBrand],
  ['genericNames', (r) => r.genericName, compareGeneric],
  ['strength', (r) => r.strengthForm, compareStrength],
];

function evaluate(
  label: ExtractedLabel,
  record: ReferenceRecord,
  registrationMatched: boolean,
): Evaluation {
  const outcomes = new Map<FieldKey, Outcome>();
  const conflicts: FieldConflict[] = [];
  // Rule 2 compares only brand, generic, strength and form; the registration
  // number counts only when rule 1 selected the record by it.
  outcomes.set('registrationNumber', registrationMatched ? 'matched' : 'missing');
  for (const [key, referenceText, compare] of COMPARATORS) {
    const labelValue = clearValue(label, key);
    const ref = referenceText(record);
    const outcome = labelValue === null || ref === null ? 'missing' : compare(labelValue, ref);
    outcomes.set(key, outcome);
    if (outcome === 'conflict' && labelValue !== null && ref !== null) {
      conflicts.push({ key, labelValue, referenceValue: ref });
    }
  }
  const form = compareDosageForm(label, record);
  outcomes.set('dosageForm', form.outcome);
  const labelForm = clearValue(label, 'dosageForm');
  if (form.outcome === 'conflict' && labelForm !== null && record.strengthForm !== null) {
    conflicts.push({
      key: 'dosageForm',
      labelValue: labelForm,
      referenceValue: record.strengthForm,
    });
  }
  const score = [...outcomes.values()].filter((o) => o === 'matched').length;
  const nameMatched =
    outcomes.get('brandName') === 'matched' || outcomes.get('genericNames') === 'matched';
  return {
    record,
    outcomes,
    conflicts,
    score,
    nameMatched,
    formBlocksVerified: form.blocksVerified,
  };
}

const is = (e: Evaluation, key: FieldKey, outcome: Outcome) => e.outcomes.get(key) === outcome;

/** Rule 3, strict. */
function isVerified(e: Evaluation): boolean {
  return (
    e.conflicts.length === 0 &&
    !e.formBlocksVerified &&
    is(e, 'registrationNumber', 'matched') &&
    is(e, 'brandName', 'matched') &&
    is(e, 'strength', 'matched')
  );
}

/**
 * Rule 4: a name match plus a matched strength. A name match on the record a
 * clear registration number selected (rule 1) also reaches `partial`.
 */
function isPartial(e: Evaluation): boolean {
  return (
    e.conflicts.length === 0 &&
    e.nameMatched &&
    (is(e, 'strength', 'matched') || is(e, 'registrationNumber', 'matched'))
  );
}

function keysWith(e: Evaluation, outcome: Outcome): FieldKey[] {
  return COMPARED.filter((k) => e.outcomes.get(k) === outcome);
}

function bestOf(evaluations: Evaluation[]): Evaluation[] {
  const top = Math.max(...evaluations.map((e) => e.score));
  return evaluations.filter((e) => e.score === top);
}

function withNotes(
  base: Omit<MatchAssessment, 'limitations'>,
  notes: readonly string[],
): MatchAssessment {
  const expiry = base.candidates.length > 0 ? [EXPIRY_NOTE] : [];
  return { ...base, limitations: [...expiry, ...notes] };
}

/**
 * A `conflicting` result over one or more records: every conflict is listed
 * (identical entries once), and a field counts as matched only if it matched
 * on every listed record.
 */
function conflictResult(
  evaluations: Evaluation[],
  advisories: MatchAssessment['advisories'],
  notes: readonly string[],
): MatchAssessment {
  const conflicting: FieldConflict[] = [];
  for (const c of evaluations.flatMap((e) => e.conflicts)) {
    const seen = conflicting.some(
      (x) =>
        x.key === c.key && x.labelValue === c.labelValue && x.referenceValue === c.referenceValue,
    );
    if (!seen) conflicting.push(c);
  }
  const matched = COMPARED.filter((k) => evaluations.every((e) => is(e, k, 'matched')));
  return withNotes(
    {
      status: 'conflicting',
      matched,
      conflicting,
      missing: COMPARED.filter(
        (k) => !matched.includes(k) && !conflicting.some((c) => c.key === k),
      ),
      candidates: evaluations.map((e) => e.record),
      advisories,
    },
    notes,
  );
}

export function assessMatch(label: ExtractedLabel, search: ReferenceSearchResult): MatchAssessment {
  const empty = { matched: [], conflicting: [], missing: [], candidates: [], advisories: [] };
  if (search.kind === 'unavailable') {
    return { status: 'unavailable', ...empty, limitations: [UNAVAILABLE_NOTE] };
  }
  if (search.kind === 'not_attempted') {
    return { status: 'not_attempted', ...empty, limitations: [NOT_ATTEMPTED_NOTE] };
  }
  const advisories = search.advisories;

  // Rule 1: a clear registration number found exactly selects that record.
  const labelReg = clearValue(label, 'registrationNumber');
  const reg = labelReg === null ? null : normalizeRegistrationNumber(labelReg);
  const byReg =
    reg === null
      ? []
      : search.records.filter((r) => normalizeRegistrationNumber(r.registrationNumber) === reg);

  let relevant: Evaluation[];
  let notes: string[] = [];
  // Rule 1 with several records under one number: any record that cannot be
  // confirmed (unrecognised form, unparseable strength, no brand) is
  // unresolved evidence for the same registration, so `verified` is out.
  let unresolvedSibling = false;
  if (byReg.length > 0) {
    relevant = byReg.map((r) => evaluate(label, r, true));
    // Rule 6 on the rule 1 path: every record under this number speaks for
    // the pack, so a conflict on any of them is never outweighed by a fit.
    const conflicted = relevant.filter((e) => e.conflicts.length > 0);
    if (conflicted.length > 0) return conflictResult(conflicted, advisories, notes);
    unresolvedSibling = relevant.length > 1 && !relevant.every(isVerified);
  } else {
    // A clear number on the pack that the registry does not hold is worth saying.
    if (labelReg !== null) notes = [REG_NOT_FOUND_NOTE];
    // Rule 2: a name search can return other products. A record is about this
    // label only if its brand or generic matches; a record whose brand
    // disagrees is a different product, not a conflict.
    relevant = search.records
      .map((r) => evaluate(label, r, false))
      .filter((e) => e.nameMatched && !is(e, 'brandName', 'conflict'));
  }
  const fitting = relevant.filter((e) => e.nameMatched && e.conflicts.length === 0);
  // Only reachable on the rule 2 path, where a fit may outrank a conflict.
  const conflicting = relevant.filter((e) => e.conflicts.length > 0);

  if (fitting.length > 0) {
    const best = bestOf(fitting);
    // Rule 7: equal best score, choose none. A tie of weak fits does not
    // outrank a conflicting record (rule 6).
    if (best.length > 1 && (conflicting.length === 0 || best.some(isPartial))) {
      const shared = COMPARED.filter((k) => best.every((e) => is(e, k, 'matched')));
      return withNotes(
        {
          status: 'ambiguous',
          matched: shared,
          conflicting: [],
          missing: COMPARED.filter((k) => !shared.includes(k)),
          candidates: best.map((e) => e.record),
          advisories,
        },
        notes,
      );
    }
    const [chosen] = best;
    if (best.length === 1 && chosen !== undefined && isPartial(chosen)) {
      return withNotes(
        {
          status: isVerified(chosen) && !unresolvedSibling ? 'verified' : 'partial',
          matched: keysWith(chosen, 'matched'),
          conflicting: [],
          missing: keysWith(chosen, 'missing'),
          candidates: [chosen.record],
          advisories,
        },
        notes,
      );
    }
  }

  // Rule 6: with no record that positively fits, a conflict outranks no_match.
  const [worst] = conflicting.length > 0 ? bestOf(conflicting) : [];
  if (worst !== undefined) return conflictResult([worst], advisories, notes);

  // Rule 8. `missing` lists the compared fields the label itself could not supply.
  return withNotes(
    {
      status: 'no_match',
      matched: [],
      conflicting: [],
      missing: COMPARED.filter((k) => clearValue(label, k) === null),
      candidates: [],
      advisories,
    },
    notes,
  );
}
