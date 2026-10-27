/**
 * Accuracy eval scoring (spec §5.1, "Accuracy eval"). Compares one live
 * label read against the owner's ground truth for a pack. A field is
 * "confidently wrong" when its value is wrong while the reader called it
 * `clear`; an `unreadable` field is never confidently wrong. Pure functions
 * only: the script in scripts/eval-labels.ts does the I/O.
 */
import type { ExtractedLabel, FieldKey, Legibility } from '@medilens/contracts';
import { z } from 'zod';
import {
  DOSAGE_FORM_MODIFIERS,
  DOSAGE_FORM_WORDS,
  normalizeName,
  normalizeRegistrationNumber,
  parseStrength,
  strengthsEqual,
} from '../domain/parsers';

/** Shape of `eval/packs/<id>/truth.json`. */
export const GroundTruthSchema = z.object({
  packId: z.string().trim().min(1),
  /** File names inside the pack folder, in reading order (1-3, as the reader accepts). */
  images: z.array(z.string().trim().min(1)).min(1).max(3),
  brandName: z.string().trim().min(1),
  genericNames: z.array(z.string().trim().min(1)).min(1),
  strength: z
    .string()
    .trim()
    .min(1)
    .refine((s) => parseStrength(s) !== null, {
      message: 'strength must be parseable, e.g. "500 mg"',
    }),
  dosageForm: z.string().trim().min(1),
  /** null when the pack prints no registration number. */
  registrationNumber: z
    .string()
    .trim()
    .min(1)
    .refine((s) => normalizeRegistrationNumber(s) !== null, {
      message: 'registrationNumber must be a recognised registration number, e.g. "DR-XY12345"',
    })
    .nullable(),
  /** null when the pack prints no expiry date. */
  expiryDate: z
    .string()
    .trim()
    .min(1)
    .refine((s) => parseMonthYear(s) !== null, {
      message: 'expiryDate must be a month and year, e.g. "03/2027", "2027-03" or "MAR 2027"',
    })
    .nullable(),
});
export type GroundTruth = z.infer<typeof GroundTruthSchema>;

export const SCORED_FIELDS = [
  'brandName',
  'genericNames',
  'strength',
  'dosageForm',
  'registrationNumber',
  'expiryDate',
] as const satisfies readonly FieldKey[];
export type ScoredField = (typeof SCORED_FIELDS)[number];

export interface FieldScore {
  field: FieldKey;
  correct: boolean;
  legibility: Legibility;
  confidentlyWrong: boolean;
}

/* ---------------------------------------------------------- comparisons */

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;
const FULL_MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

/** An optional leading `EXP`, `Exp.`, `EXP:`, `Expiry`, `Expiry date:`. */
const EXP_PREFIX = /^exp(?:iry)?(?:\s+date)?\s*[.:]?\s*/i;
const MM_YYYY = /^(\d{1,2})\s*[/-]\s*(\d{4})$/;
const YYYY_MM = /^(\d{4})\s*[/-]\s*(\d{1,2})$/;
const MON_YYYY = /^([a-z]+)\.?\s+(\d{4})$/i;

export interface MonthYear {
  month: number;
  year: number;
}

/**
 * Reads an expiry as month + year. Accepts MM/YYYY, MM-YYYY, YYYY-MM and
 * MON YYYY, each with an optional `EXP` prefix. Anything else is null.
 */
export function parseMonthYear(s: string): MonthYear | null {
  const text = s.trim().replace(EXP_PREFIX, '').trim();
  let month: number;
  let year: number;
  let m: RegExpExecArray | null;
  if ((m = MM_YYYY.exec(text))) {
    month = Number(m[1]);
    year = Number(m[2]);
  } else if ((m = YYYY_MM.exec(text))) {
    year = Number(m[1]);
    month = Number(m[2]);
  } else if ((m = MON_YYYY.exec(text))) {
    const word = (m[1] ?? '').toLowerCase();
    const idx = Math.max(
      MONTHS.indexOf(word as (typeof MONTHS)[number]),
      FULL_MONTHS.indexOf(word as (typeof FULL_MONTHS)[number]),
    );
    if (idx === -1) return null;
    month = idx + 1;
    year = Number(m[2]);
  } else {
    return null;
  }
  if (month < 1 || month > 12) return null;
  return { month, year };
}

/**
 * Canonical dosage form text. `normalizeName` drops form words (it is built
 * for brand names), so forms are canonicalised here with the same shared
 * vocabulary: `Film-coated tablets` → `tablet`, `Eye Drops` → `eye drops`.
 */
function canonicalForm(s: string): string {
  // Qualifiers such as `eye` are ordinary words here, so `eye drops` stays distinct from `ear drops`.
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '' && !DOSAGE_FORM_MODIFIERS.has(w))
    .map((w) => (Object.hasOwn(DOSAGE_FORM_WORDS, w) ? DOSAGE_FORM_WORDS[w] : w))
    .join(' ');
}

/** Generic names on a label, e.g. `Amoxicillin + Clavulanic acid`, as a sorted set. */
function genericSet(names: string[]): string[] {
  const set = new Set(
    names
      .flatMap((n) => n.split(/\s*(?:[,+/;&]|\band\b)\s*/i))
      .map(normalizeName)
      .filter((n) => n !== ''),
  );
  return [...set].sort();
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Is a non-null read value equal to the truth for this field? */
function valueMatches(field: ScoredField, truth: GroundTruth, value: string): boolean {
  switch (field) {
    case 'brandName': {
      const t = normalizeName(truth.brandName);
      return t !== '' && t === normalizeName(value);
    }
    case 'genericNames': {
      const t = genericSet(truth.genericNames);
      return t.length > 0 && sameList(t, genericSet([value]));
    }
    case 'strength':
      // strengthsEqual is false when either side is unparseable.
      return strengthsEqual(parseStrength(truth.strength), parseStrength(value));
    case 'dosageForm':
      return canonicalForm(truth.dosageForm) === canonicalForm(value);
    case 'registrationNumber': {
      if (truth.registrationNumber === null) return false;
      const t = normalizeRegistrationNumber(truth.registrationNumber);
      return t !== null && t === normalizeRegistrationNumber(value);
    }
    case 'expiryDate': {
      if (truth.expiryDate === null) return false;
      const t = parseMonthYear(truth.expiryDate);
      const r = parseMonthYear(value);
      return t !== null && r !== null && t.month === r.month && t.year === r.year;
    }
  }
}

function truthIsNull(field: ScoredField, truth: GroundTruth): boolean {
  return (
    (field === 'registrationNumber' && truth.registrationNumber === null) ||
    (field === 'expiryDate' && truth.expiryDate === null)
  );
}

/**
 * Scores the six eval fields of one read. A field missing from the read is
 * scored as an unreadable null. A null truth (not printed on the pack) is
 * correct when the read is null or unreadable.
 */
export function scoreLabel(truth: GroundTruth, label: ExtractedLabel): FieldScore[] {
  return SCORED_FIELDS.map((field) => {
    const read = label.fields.find((f) => f.key === field);
    const value = read?.value ?? null;
    const legibility: Legibility = read?.legibility ?? 'unreadable';
    const correct = truthIsNull(field, truth)
      ? value === null || legibility === 'unreadable'
      : value !== null && valueMatches(field, truth, value);
    return { field, correct, legibility, confidentlyWrong: !correct && legibility === 'clear' };
  });
}

/* ------------------------------------------------------------- aggregate */

export interface FieldSummary {
  field: FieldKey;
  total: number;
  correct: number;
  unreadable: number;
  confidentlyWrong: number;
}

export interface EvalSummary {
  packs: number;
  fields: FieldSummary[];
}

/** Aggregate counts only: no pack ids, no read values. */
export function summarize(perPack: FieldScore[][]): EvalSummary {
  const fields = SCORED_FIELDS.map((field) => {
    const scores = perPack.flatMap((p) => p.filter((s) => s.field === field));
    return {
      field,
      total: scores.length,
      correct: scores.filter((s) => s.correct).length,
      unreadable: scores.filter((s) => s.legibility === 'unreadable').length,
      confidentlyWrong: scores.filter((s) => s.confidentlyWrong).length,
    };
  });
  return { packs: perPack.length, fields };
}

/** The bar (spec §5.1): zero confidently-wrong strengths or expiry dates. */
export function meetsBar(summary: EvalSummary): boolean {
  return summary.fields
    .filter((f) => f.field === 'strength' || f.field === 'expiryDate')
    .every((f) => f.confidentlyWrong === 0);
}

/** Markdown for docs/eval-results.md: aggregate counts only, no images or raw text. */
export function renderResultsMarkdown(summary: EvalSummary, date: string): string {
  const rows = summary.fields.map(
    (f) => `| ${f.field} | ${f.total} | ${f.correct} | ${f.unreadable} | ${f.confidentlyWrong} |`,
  );
  return [
    '# Label accuracy eval results',
    '',
    `Run date: ${date}. Packs scored: ${summary.packs}. Reader: live Muse Spark.`,
    '',
    "Aggregate counts only. Photos, pack identities and read text stay on the owner's machine.",
    '',
    '| Field | Total | Correct | Unreadable | Confidently wrong |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `Bar (zero confidently-wrong strengths or expiry dates): ${meetsBar(summary) ? 'MET' : 'NOT MET'}.`,
    '',
  ].join('\n');
}
