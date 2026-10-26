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
// Longest spellings first. A unit must not be followed by another letter, so `500 gel` does not parse.
const UNIT = String.raw`(micrograms?|milligrams?|grams?|mcg|mg|g|ml|iu|%)(?![a-z])`;
const PER_SEP = String.raw`\s*(?:\/|per(?![a-z]))\s*`;
const PER = String.raw`(?:${PER_SEP}(\d+(?:\.\d+)?)?\s*(ml|g|l)(?![a-z]))?`;
// Lookbehind stops a match starting in the middle of a number or a word (e.g. `B12mg`).
const STRENGTH_RE = new RegExp(String.raw`(?<![\d.a-z])${NUMBER}\s*${UNIT}${PER}`, 'gi');
const STARTS_WITH_STRENGTH = new RegExp(String.raw`^${NUMBER}\s*${UNIT}`, 'i');
/** A `/` or `per` directly after a strength, i.e. a concentration we did not recognise. */
const DANGLING_SEP = /^\s*(\/|per(?![a-z]))\s*/i;

/** Digit runs joined by commas, e.g. `1,000` or `500,125`. */
const COMMA_NUMBER = /\d+(?:,\d+)+/g;
/**
 * Accepted thousands grouping. The leading group is 1-2 digits on purpose:
 * `500,125` has the same shape as a 3-digit-led thousands number but is more
 * likely two merged strengths, so anything that ambiguous is rejected.
 */
const THOUSANDS = /^\d{1,2}(?:,\d{3})+$/;
/**
 * `1.000 mg` may be a European thousands separator (1000) or a decimal (1).
 * A leading zero (`0.125 mg`) cannot be a thousands group, so it stays a decimal.
 */
const DOTTED_THOUSANDS = /(?<![\d.])[1-9]\d{0,2}\.\d{3}(?!\d)\s*[a-zµμ%]/i;

/** A number followed by a word, left over once the recognised strengths are blanked out. */
const RESIDUAL = /(?<![\d.a-z])\d+(?:\.\d+)?\s*([a-zµμ%]+)/gi;
/** Fail closed: the only words allowed after a leftover number. Anything else may be a unit. */
const NON_UNIT_WORDS = new Set([
  'tablet',
  'tablets',
  'capsule',
  'capsules',
  'caplet',
  'caplets',
  'sachet',
  'sachets',
  'each',
  'x',
  'forte',
  'plus',
  'and',
]);

const UNIT_MAP: Record<string, StrengthUnit> = {
  mcg: 'mcg',
  microgram: 'mcg',
  micrograms: 'mcg',
  mg: 'mg',
  milligram: 'mg',
  milligrams: 'mg',
  g: 'g',
  gram: 'g',
  grams: 'g',
  ml: 'mL',
  iu: 'IU',
  '%': '%',
};
const PER_UNIT_MAP: Record<string, PerUnit> = { ml: 'mL', g: 'g', l: 'L' };

/**
 * Parses every strength in `s`. Fails closed: returns null when nothing is
 * found, and also when anything cannot be fully understood (an unknown `per`
 * unit, a number followed by a word that is not a known non-unit word, an
 * ambiguous comma or dot number). Silently dropping part of a strength could
 * make two different products compare equal.
 */
export function parseStrength(s: string): Strength[] | null {
  let text = s.replace(/[µμ]g/gi, 'mcg');

  if (DOTTED_THOUSANDS.test(text)) return null;
  for (const [token] of text.matchAll(COMMA_NUMBER)) {
    if (!THOUSANDS.test(token)) return null;
  }
  text = text.replace(COMMA_NUMBER, (token) => token.replace(/,/g, ''));

  const out: Strength[] = [];
  let residual = text;
  for (const m of text.matchAll(STRENGTH_RE)) {
    const end = m.index + m[0].length;
    const sep = DANGLING_SEP.exec(text.slice(end));
    // Only `500mg/125mg` (a slash between two strengths) is allowed to follow a strength.
    if (sep && !(sep[1] === '/' && STARTS_WITH_STRENGTH.test(text.slice(end + sep[0].length)))) {
      return null;
    }
    residual = residual.slice(0, m.index) + ' '.repeat(m[0].length) + residual.slice(end);

    const [, amountStr, unitStr, perAmountStr, perUnitStr] = m;
    const unit = UNIT_MAP[(unitStr ?? '').toLowerCase()];
    if (amountStr === undefined || unit === undefined) return null;
    const entry: Strength = { amount: Number(amountStr), unit };
    if (perUnitStr !== undefined) {
      const perUnit = PER_UNIT_MAP[perUnitStr.toLowerCase()];
      if (perUnit === undefined) return null;
      entry.per = {
        amount: perAmountStr === undefined ? 1 : Number(perAmountStr),
        unit: perUnit,
      };
    }
    out.push(entry);
  }

  for (const [, word] of residual.matchAll(RESIDUAL)) {
    if (!NON_UNIT_WORDS.has((word ?? '').toLowerCase())) return null;
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
