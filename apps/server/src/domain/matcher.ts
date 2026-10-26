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
  normalizeName,
  normalizeRegistrationNumber,
  parseStrength,
  strengthsEqual,
} from './parsers';

const EXPIRY_NOTE = "Registration expiry is not the product's expiry date.";
const UNAVAILABLE_NOTE = 'Registry lookup unavailable; nothing was verified.';
const NOT_ATTEMPTED_NOTE = 'Registry lookup was not attempted.';

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

/** Recognised dosage-form words and their canonical form. `film-coated` alone names no form. */
const FORM_WORDS: Record<string, string> = {
  tablet: 'tablet',
  tablets: 'tablet',
  capsule: 'capsule',
  capsules: 'capsule',
  caplet: 'caplet',
  caplets: 'caplet',
  syrup: 'syrup',
  suspension: 'suspension',
  cream: 'cream',
  ointment: 'ointment',
  drops: 'drops',
  solution: 'solution',
  injection: 'injection',
};

function formSet(s: string): Set<string> {
  const forms = new Set<string>();
  for (const word of s.toLowerCase().split(/[^\p{L}-]+/u)) {
    const form = FORM_WORDS[word];
    if (form !== undefined) forms.add(form);
  }
  return forms;
}

/** Spec rule 3: a side with no recognisable form word leaves the form `missing`. */
function compareDosageForm(labelValue: string, strengthForm: string): Outcome {
  const a = formSet(labelValue);
  const b = formSet(strengthForm);
  if (a.size === 0 || b.size === 0) return 'missing';
  return setsEqual(a, b) ? 'matched' : 'conflict';
}

/** The record's original text that a label field is compared against. */
function referenceText(record: ReferenceRecord, key: FieldKey): string | null {
  switch (key) {
    case 'brandName':
      return record.brandName;
    case 'genericNames':
      return record.genericName;
    case 'strength':
    case 'dosageForm':
      return record.strengthForm;
    default:
      return null;
  }
}

const COMPARATORS: readonly [FieldKey, (labelValue: string, ref: string) => Outcome][] = [
  ['brandName', compareBrand],
  ['genericNames', compareGeneric],
  ['strength', compareStrength],
  ['dosageForm', compareDosageForm],
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
  for (const [key, compare] of COMPARATORS) {
    const labelValue = clearValue(label, key);
    const ref = referenceText(record, key);
    const outcome = labelValue === null || ref === null ? 'missing' : compare(labelValue, ref);
    outcomes.set(key, outcome);
    if (outcome === 'conflict' && labelValue !== null && ref !== null) {
      conflicts.push({ key, labelValue, referenceValue: ref });
    }
  }
  const score = [...outcomes.values()].filter((o) => o === 'matched').length;
  const nameMatched =
    outcomes.get('brandName') === 'matched' || outcomes.get('genericNames') === 'matched';
  return { record, outcomes, conflicts, score, nameMatched };
}

const is = (e: Evaluation, key: FieldKey, outcome: Outcome) => e.outcomes.get(key) === outcome;

/** Rule 3, strict. */
function isVerified(e: Evaluation): boolean {
  return (
    e.conflicts.length === 0 &&
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

function withRecords(base: Omit<MatchAssessment, 'limitations'>): MatchAssessment {
  return { ...base, limitations: base.candidates.length > 0 ? [EXPIRY_NOTE] : [] };
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
  if (byReg.length > 0) {
    relevant = byReg.map((r) => evaluate(label, r, true));
  } else {
    // Rule 2: a name search can return other products. A record is about this
    // label only if its brand or generic matches; a record whose brand
    // disagrees is a different product, not a conflict.
    relevant = search.records
      .map((r) => evaluate(label, r, false))
      .filter((e) => e.nameMatched && !is(e, 'brandName', 'conflict'));
  }
  // In the rule 1 path a record with no name match can still conflict.
  const fitting = relevant.filter((e) => e.nameMatched && e.conflicts.length === 0);
  const conflicting = relevant.filter((e) => e.conflicts.length > 0);

  if (fitting.length > 0) {
    const best = bestOf(fitting);
    // Rule 7: equal best score, choose none. A tie of weak fits does not
    // outrank a conflicting record (rule 6).
    if (best.length > 1 && (conflicting.length === 0 || best.some(isPartial))) {
      const shared = COMPARED.filter((k) => best.every((e) => is(e, k, 'matched')));
      return withRecords({
        status: 'ambiguous',
        matched: shared,
        conflicting: [],
        missing: COMPARED.filter((k) => !shared.includes(k)),
        candidates: best.map((e) => e.record),
        advisories,
      });
    }
    const [chosen] = best;
    if (best.length === 1 && chosen !== undefined && isPartial(chosen)) {
      return withRecords({
        status: isVerified(chosen) ? 'verified' : 'partial',
        matched: keysWith(chosen, 'matched'),
        conflicting: [],
        missing: keysWith(chosen, 'missing'),
        candidates: [chosen.record],
        advisories,
      });
    }
  }

  // Rule 6: with no record that positively fits, a conflict outranks no_match.
  if (conflicting.length > 0) {
    const [chosen] = bestOf(conflicting);
    if (chosen !== undefined) {
      return withRecords({
        status: 'conflicting',
        matched: keysWith(chosen, 'matched'),
        conflicting: chosen.conflicts,
        missing: keysWith(chosen, 'missing'),
        candidates: [chosen.record],
        advisories,
      });
    }
  }

  // Rule 8. `missing` lists the compared fields the label itself could not supply.
  return withRecords({
    status: 'no_match',
    matched: [],
    conflicting: [],
    missing: COMPARED.filter((k) => clearValue(label, k) === null),
    candidates: [],
    advisories,
  });
}
