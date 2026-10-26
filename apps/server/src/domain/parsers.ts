/**
 * Pure string parsers used by the deterministic label/registry matcher.
 * Every function here is conservative: when in doubt it returns null or
 * "not equal", so a mismatch is surfaced instead of a false confirmation.
 */

export type StrengthUnit = 'mg' | 'mcg' | 'g' | 'mL' | 'IU' | '%';
export type PerUnit = 'mL' | 'g' | 'L';

export interface Strength {
  amount: number;
  unit: StrengthUnit;
  /** Only present for concentrations such as `250 mg/5 mL`. */
  per?: { amount: number; unit: PerUnit };
}

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
// Unit must not be followed by another letter, so `500 gel` and `5 mgx` do not parse.
const UNIT = String.raw`(mcg|mg|g|ml|iu|%)(?![a-z])`;
const PER = String.raw`(?:\s*\/\s*(\d+(?:\.\d+)?)?\s*(ml|g|l)(?![a-z]))?`;
// Lookbehind stops a match starting in the middle of a number or a word (e.g. `B12mg`),
// or after a decimal comma (`1,5 mg` must not read as `5 mg`).
const STRENGTH_RE = new RegExp(String.raw`(?<![\d.a-z]|\d,)${NUMBER}\s*${UNIT}${PER}`, 'gi');

const UNIT_MAP: Record<string, StrengthUnit> = {
  mcg: 'mcg',
  mg: 'mg',
  g: 'g',
  ml: 'mL',
  iu: 'IU',
  '%': '%',
};
const PER_UNIT_MAP: Record<string, PerUnit> = { ml: 'mL', g: 'g', l: 'L' };

export function parseStrength(s: string): Strength[] | null {
  const text = s
    .replace(/[µμ]g/gi, 'mcg')
    // Thousands separators: `1,000` -> `1000` (a comma followed by exactly three digits).
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1');

  const out: Strength[] = [];
  for (const m of text.matchAll(STRENGTH_RE)) {
    const [, amountStr, unitStr, perAmountStr, perUnitStr] = m;
    const unit = UNIT_MAP[(unitStr ?? '').toLowerCase()];
    if (amountStr === undefined || unit === undefined) continue;
    const entry: Strength = { amount: Number(amountStr), unit };
    if (perUnitStr !== undefined) {
      const perUnit = PER_UNIT_MAP[perUnitStr.toLowerCase()];
      if (perUnit !== undefined) {
        entry.per = {
          amount: perAmountStr === undefined ? 1 : Number(perAmountStr),
          unit: perUnit,
        };
      }
    }
    out.push(entry);
  }
  return out.length > 0 ? out : null;
}

interface Canonical {
  amount: number;
  dimension: string;
  perAmount: number | null;
  perDimension: string | null;
}

const MASS_TO_MCG: Partial<Record<StrengthUnit, number>> = { mcg: 1, mg: 1_000, g: 1_000_000 };
const PER_TO_BASE: Record<PerUnit, { factor: number; dimension: string }> = {
  mL: { factor: 1, dimension: 'mL' },
  L: { factor: 1_000, dimension: 'mL' },
  g: { factor: 1, dimension: 'g' },
};

function canonical(s: Strength): Canonical {
  const massFactor = MASS_TO_MCG[s.unit];
  const per = s.per ? PER_TO_BASE[s.per.unit] : undefined;
  return {
    amount: massFactor === undefined ? s.amount : s.amount * massFactor,
    dimension: massFactor === undefined ? s.unit : 'mass',
    perAmount: s.per && per ? s.per.amount * per.factor : null,
    perDimension: per ? per.dimension : null,
  };
}

function numbersEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1);
}

function canonicalEqual(a: Canonical, b: Canonical): boolean {
  if (a.dimension !== b.dimension || a.perDimension !== b.perDimension) return false;
  if (!numbersEqual(a.amount, b.amount)) return false;
  if (a.perAmount === null || b.perAmount === null) return a.perAmount === b.perAmount;
  return numbersEqual(a.perAmount, b.perAmount);
}

/**
 * Multiset equality after unit normalisation (mcg/mg/g convert; IU, % and mL
 * only compare with the same unit). `per` must match exactly after unit
 * normalisation: `250 mg/5 mL` is NOT treated as equal to `50 mg/mL`.
 */
export function strengthsEqual(a: Strength[] | null, b: Strength[] | null): boolean {
  if (a === null || b === null || a.length !== b.length) return false;
  const remaining = b.map(canonical);
  for (const item of a.map(canonical)) {
    const idx = remaining.findIndex((r) => canonicalEqual(item, r));
    if (idx === -1) return false;
    remaining.splice(idx, 1);
  }
  return true;
}

const REG_RE = /^(?:DR-XY|DRHR-|DRP-|DR-)\d+$/;

export function normalizeRegistrationNumber(s: string): string | null {
  const cleaned = s
    .toUpperCase()
    .replace(/\s+/g, '')
    // OCR often yields typographic dashes.
    .replace(/[‐-―−]/g, '-');
  return REG_RE.test(cleaned) ? cleaned : null;
}

const DOSAGE_FORM_WORDS = new Set([
  'tablet',
  'tablets',
  'capsule',
  'capsules',
  'caplet',
  'syrup',
  'suspension',
  'cream',
  'ointment',
  'drops',
  'solution',
  'injection',
  'film-coated',
]);

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[®™]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '' && !DOSAGE_FORM_WORDS.has(word))
    .join(' ');
}
