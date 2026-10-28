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

/**
 * Digit runs joined by commas, e.g. `1,000` or `500,125`. A run that starts
 * right after another number, a `.` or a `,` (`0.5,000`) is not a candidate.
 */
const COMMA_NUMBER = /(?<![\p{N}.,])\d+(?:,\d+)+/gu;
/**
 * Accepted thousands grouping. The leading group is 1-2 digits on purpose:
 * `500,125` has the same shape as a 3-digit-led thousands number but is more
 * likely two merged strengths, so anything that ambiguous is rejected. It may
 * not start with 0: `0,500` and `0,125` are decimal commas, not 500 and 125.
 */
const THOUSANDS = /^[1-9]\d?(?:,\d{3})+$/;
/**
 * Every run of non-letter characters that sits between two numbers. The
 * lookahead lets runs overlap, so `1~2~3` yields both joins.
 */
const NUMBER_GAP = /\p{N}(?=([^\p{L}\p{N}]+)\p{N})/gu;
/**
 * The only accepted joins between two numbers (an allowlist, not a
 * blocklist): whitespace, a glued decimal point (`0.5`), or closing brackets
 * glued to the left number and followed by whitespace (`(Vitamin D3) 400 IU`).
 * Each such bracket must also pass `closesWordGroup`. Valid thousands commas
 * are removed before this runs. Anything else, such as a decimal comma
 * (`0,5`), a fraction (`1/2`, `½` → `1⁄2`), a range (`1-2`, `1~2`), a ratio
 * (`3:5`), an operator (`1×2`, `1÷2`) or a foreign decimal mark (`0·5`,
 * `0。5`), means we cannot tell which part is the amount. A `/` after a unit
 * (`250 mg/5 mL`) is not between two numbers, so it is allowed.
 */
const ACCEPTED_JOIN = /^(?:\s+|\.|[)\]]+\s+)$/u;
/** Format characters (zero-width space, soft hyphen, BOM, ...) are rejected, never stripped. */
const FORMAT_CHAR = /\p{Cf}/u;
/** A word of two or more letters; the `x` of a pack grid such as `(10x1)` is not one. */
const WORD = /\p{L}{2}/u;

/**
 * True when the bracket at `text[at]` closes a group of the same bracket type
 * opened earlier in `text`, and that group holds a word (`(Vitamin D3)`). An
 * unbalanced bracket (`10x1) 2 mg`) or a group of only numbers and pack-grid
 * letters (`(10x1) 2 mg`) does not.
 */
function closesWordGroup(text: string, at: number): boolean {
  const close = text[at];
  const open = close === ')' ? '(' : '[';
  let depth = 0;
  for (let j = at - 1; j >= 0; j--) {
    if (text[j] === close) depth++;
    else if (text[j] === open) {
      if (depth === 0) return WORD.test(text.slice(j + 1, at));
      depth--;
    }
  }
  return false;
}

/** True when `gap`, found at `text[start]`, is an accepted join between two numbers. */
function isAcceptedJoin(text: string, start: number, gap: string): boolean {
  if (!ACCEPTED_JOIN.test(gap)) return false;
  for (let k = 0; k < gap.length; k++) {
    if ((gap[k] === ')' || gap[k] === ']') && !closesWordGroup(text, start + k)) return false;
  }
  return true;
}

/** True when some pair of numbers in `text` is joined by anything but an accepted join. */
function hasUnacceptedJoin(text: string): boolean {
  for (const m of text.matchAll(NUMBER_GAP)) {
    if (!isAcceptedJoin(text, m.index + m[0].length, m[1] ?? '')) return true;
  }
  return false;
}
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
 * connectors `plus` and `and`. Any other word, symbol, `%` or `‰` counts as
 * unit-like.
 */
const FOLLOWER_WORD =
  /^(?:tablets?|capsules?|caplets?|sachets?|each|x|forte|plus|and)(?![\p{L}\p{N}])/iu;
/**
 * Characters skipped while looking for what follows a match. Digits, letters,
 * symbols (`℥`, `$`), `%`, `‰` and the strength marker stop the scan.
 */
const FOLLOWER_SKIP = /^[^\p{L}\p{N}\p{So}\p{Sc}%‰\uE000]*/u;
const UNIT_LIKE_START = /^[\p{L}\p{So}\p{Sc}%‰]/u;
/** A slash after an allowlisted match (`10 tablets/2 mg`) is a ratio we do not read. */
const SLASH_LIKE = /[/\\⁄∕]/u;
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
 * past any chain of allowed follower words) with a letter, a symbol, `%` or
 * `‰`, i.e. something that could be the unit of the number just before it,
 * or when a slash is skipped on the way. A digit or a blanked strength is
 * safe only when the gap before it is empty or an accepted join
 * (`10 tablets ÷ 2 mg` is not). The end of the string is safe. `text` is the
 * unblanked input (same length as `s`), used to check bracket groups.
 */
function followedByUnitLikeText(s: string, from: number, text: string): boolean {
  let i = from;
  for (;;) {
    const skipped = FOLLOWER_SKIP.exec(s.slice(i))?.[0] ?? '';
    if (SLASH_LIKE.test(skipped)) return true;
    const start = i;
    i += skipped.length;
    const rest = s.slice(i);
    if (rest === '') return false;
    // A digit or blanked strength is next: the gap must be an accepted join.
    if (!UNIT_LIKE_START.test(rest)) {
      return skipped !== '' && !isAcceptedJoin(text, start, skipped);
    }
    const word = FOLLOWER_WORD.exec(rest);
    if (word === null) return true;
    i += word[0].length;
  }
}

/**
 * Blanks every match of an allowlisted pattern, or returns null if any match
 * is followed by unit-like text (the parse must then fail closed).
 */
function blankAllowlisted(residual: string, pattern: RegExp, text: string): string | null {
  let out = residual;
  for (const m of residual.matchAll(pattern)) {
    const end = m.index + m[0].length;
    if (followedByUnitLikeText(residual, end, text)) return null;
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
  // A zero-width character can hide a join between numbers (`0<ZWSP>,5`).
  if (FORMAT_CHAR.test(text)) return null;

  // A digit-consumed `1.000 mg` would read as 1 mg, so it is rejected explicitly.
  if (DOTTED_THOUSANDS.test(text)) return null;
  // Only valid thousands groupings lose their commas. Anything else keeps the
  // comma, so its leading digits are left over and the invariant rejects it.
  text = text.replace(COMMA_NUMBER, (token) =>
    THOUSANDS.test(token) ? token.replace(/,/g, '') : token,
  );
  // A number split by punctuation (`2 x 0,5 mg`, `10x1~2 mg`, `B12,5 mg`)
  // would otherwise have its tail read as the strength, a wrong amount.
  if (hasUnacceptedJoin(text)) return null;

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
    const next = blankAllowlisted(residual, pattern, text);
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

/**
 * The one dosage-form vocabulary: lower-case word → canonical form. The
 * matcher compares canonical forms, and `normalizeName` drops every word here
 * (and every modifier) from names. Edit this list, never a copy of it.
 */
export const DOSAGE_FORM_WORDS: Readonly<Record<string, string>> = {
  tablet: 'tablet',
  tablets: 'tablet',
  capsule: 'capsule',
  capsules: 'capsule',
  // A softgel is a soft gelatin capsule.
  softgel: 'capsule',
  softgels: 'capsule',
  caplet: 'caplet',
  caplets: 'caplet',
  syrup: 'syrup',
  elixir: 'elixir',
  suspension: 'suspension',
  solution: 'solution',
  cream: 'cream',
  ointment: 'ointment',
  gel: 'gel',
  lotion: 'lotion',
  drop: 'drops',
  drops: 'drops',
  injection: 'injection',
  powder: 'powder',
  granule: 'granules',
  granules: 'granules',
  sachet: 'sachet',
  sachets: 'sachet',
  suppository: 'suppository',
  suppositories: 'suppository',
  spray: 'spray',
  lozenge: 'lozenge',
  lozenges: 'lozenge',
  patch: 'patch',
  patches: 'patch',
  inhaler: 'inhaler',
};
/** Words that qualify a form without changing it: a film-coated tablet is a tablet. */
export const DOSAGE_FORM_MODIFIERS: ReadonlySet<string> = new Set(['film-coated']);
/**
 * Words that make `drops` a different form (`eye drops` is not `ear drops`).
 * `normalizeName` keeps them, because they also occur in brand names.
 */
export const DROPS_QUALIFIERS: ReadonlySet<string> = new Set(['eye', 'ear', 'nasal']);

const isFormWord = (word: string) =>
  Object.hasOwn(DOSAGE_FORM_WORDS, word) || DOSAGE_FORM_MODIFIERS.has(word);

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[®™]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '' && !isFormWord(word))
    .join(' ');
}
