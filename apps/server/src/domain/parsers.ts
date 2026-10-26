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

/*
 * Allowlisted non-strength patterns. They run only on what is left after the
 * strengths are blanked out. A match is accepted only if no unit-like text
 * follows it (see `followedByUnitLikeText`), otherwise it could swallow the
 * number of an unrecognised strength such as `1x65mg` or `65 x mg`. Any
 * numeric character still left means the string held something we did not
 * understand, so the whole parse fails closed.
 */
/** A pack grid such as `10 x 10` or `10x10`. */
const PACK_GRID = /(?<![\p{L}\p{N}.])\d+\s*x\s*\d+(?![\p{N}.])/giu;
/** A count followed by an allowlisted word, e.g. `10 tablets`, `2 x`, `500 Forte`. */
const COUNT_WORD =
  /(?<![\p{L}\p{N}.])\d+\s*(?:tablets?|capsules?|caplets?|sachets?|each|x|forte)(?![\p{L}\p{N}])/giu;
/** Vitamin names whose digits are not amounts, e.g. `B12`, `D3`. */
const VITAMIN_NAME = /(?<![\p{L}\p{N}])(?:b(?:1|2|3|5|6|7|9|12)|d2|d3|k1|k2)(?![\p{L}\p{N}])/giu;
/**
 * Words that may follow an allowlisted match: the count words plus the
 * connectors `plus` and `and`. Any other word, `%` or `‰` counts as unit-like.
 */
const FOLLOWER_WORD =
  /^(?:tablets?|capsules?|caplets?|sachets?|each|x|forte|plus|and)(?![\p{L}\p{N}])/iu;
/**
 * Characters skipped while looking for what follows a match. Digits, letters,
 * `%`, `‰` and the strength marker stop the scan.
 */
const FOLLOWER_SKIP = /^[^\p{L}\p{N}%‰\uE000]*/u;
const UNIT_LIKE_START = /^[\p{L}%‰]/u;
/** Private-use character that marks where a recognised strength was blanked out. */
const STRENGTH_MARK = '\uE000';

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

const blank = (match: string) => ' '.repeat(match.length);

/**
 * True when the text after `from` starts (past spaces and punctuation, and
 * past any chain of allowed follower words) with a letter, `%` or `‰`, i.e.
 * something that could be the unit of the number just before it. A digit, a
 * blanked strength or the end of the string is safe.
 */
function followedByUnitLikeText(s: string, from: number): boolean {
  let i = from;
  for (;;) {
    i += FOLLOWER_SKIP.exec(s.slice(i))?.[0].length ?? 0;
    const rest = s.slice(i);
    if (!UNIT_LIKE_START.test(rest)) return false;
    const word = FOLLOWER_WORD.exec(rest);
    if (word === null) return true;
    i += word[0].length;
  }
}

/**
 * Blanks every match of an allowlisted pattern, or returns null if any match
 * is followed by unit-like text (the parse must then fail closed).
 */
function blankAllowlisted(residual: string, pattern: RegExp): string | null {
  let out = residual;
  for (const m of residual.matchAll(pattern)) {
    const end = m.index + m[0].length;
    if (followedByUnitLikeText(residual, end)) return null;
    out = out.slice(0, m.index) + blank(m[0]) + out.slice(end);
  }
  return out;
}

/**
 * Parses every strength in `s` and fails closed. The invariant is that every
 * digit in the input must be consumed, either by a recognised strength or by
 * an allowlisted non-strength pattern (pack counts, vitamin names). If any
 * digit is left over, or a strength has an unknown `per`, or the number is an
 * ambiguous `1.000`, the result is null. Silently dropping part of a strength
 * could make two different products compare equal.
 */
export function parseStrength(s: string): Strength[] | null {
  // NFKC folds full-width `ｍｇ`, the `㎎` ligature and NBSP into plain text.
  let text = s.normalize('NFKC').replace(/[µμ]g/gi, 'mcg');
  // The strength marker must not be forgeable from the input.
  if (text.includes(STRENGTH_MARK)) return null;

  // A digit-consumed `1.000 mg` would read as 1 mg, so it is rejected explicitly.
  if (DOTTED_THOUSANDS.test(text)) return null;
  // Only valid thousands groupings lose their commas. Anything else keeps the
  // comma, so its leading digits are left over and the invariant rejects it.
  text = text.replace(COMMA_NUMBER, (token) =>
    THOUSANDS.test(token) ? token.replace(/,/g, '') : token,
  );

  const out: Strength[] = [];
  let residual = text;
  for (const m of text.matchAll(STRENGTH_RE)) {
    const end = m.index + m[0].length;
    const sep = DANGLING_SEP.exec(text.slice(end));
    // Only `500mg/125mg` (a slash between two strengths) is allowed to follow a strength.
    if (sep && !(sep[1] === '/' && STARTS_WITH_STRENGTH.test(text.slice(end + sep[0].length)))) {
      return null;
    }
    residual = residual.slice(0, m.index) + STRENGTH_MARK.repeat(m[0].length) + residual.slice(end);

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

  for (const pattern of [PACK_GRID, COUNT_WORD, VITAMIN_NAME]) {
    const next = blankAllowlisted(residual, pattern);
    if (next === null) return null;
    residual = next;
  }
  // `\p{N}` also catches digits that `\d` misses, e.g. Arabic-Indic `١٠` or Bengali `১০`.
  if (/\p{N}/u.test(residual)) return null;

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
