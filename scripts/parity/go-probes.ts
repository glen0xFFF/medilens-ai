/**
 * Extra reference outputs for the Go port of the safety gate and matcher
 * (task G3), recorded from the Node build. They complement the parity
 * corpora in fixtures/parity: those replay the TS test suite, these probe
 * the places where JS and Go differ by construction.
 *
 *   npx tsx scripts/parity/go-probes.ts
 *
 * Deterministic (seeded mulberry32, sorted output); re-running gives the
 * same files. After the Node server is removed (task G12) re-recording needs
 * `git checkout node-fallback-v1` first (ruling R4). Writes:
 *
 * 1. internal/jsregex/testdata/v8_probes.jsonl: hand-written and seeded
 *    random RegExp probes run through V8 (exec result: index and captures).
 *    The Go JS-semantics matcher must reproduce every one.
 * 2. internal/domain/testdata/safety_adversarial.jsonl: classifyQuestion,
 *    extractExplainPhrase and askedFields on seeded adversarial variants of
 *    every question in fixtures/parity/safety.jsonl (casing, Unicode
 *    confusables, zero-width and format characters, whitespace, punctuation,
 *    digits, long inputs around the 300 code-unit limit).
 * 3. internal/domain/testdata/safety_regexps.json: every flagless RegExp the
 *    safety module runs (literal or constructed), captured while the
 *    questions above are classified, with V8's test() result for each
 *    pattern on every text any pattern saw, and exec() results for the
 *    patterns safety.ts calls exec on. The Go test checks that the Go pattern
 *    sources are exactly these and that its matcher agrees on every pair.
 * 4. internal/domain/testdata/js_unicode.json: per code point, the JS
 *    Unicode behaviour the Go port re-implements: \s, \p{Cf}, \p{L}, \p{N},
 *    \p{Pd}, [\p{Cf}\p{Default_Ignorable_Code_Point}], toLowerCase and NFKC,
 *    plus \p{Cased}, \p{Case_Ignorable} and toLowerCase's Final_Sigma
 *    context (whether the Σ in `AΣc`, `AΣcA`, `cΣ` and `AcΣ` becomes ς).
 * 5. internal/domain/testdata/matcher_regexps.jsonl: the matcher's i- and
 *    u-flag RegExps (each checked to appear verbatim in matcher.ts) on every
 *    string in fixtures/parity/matcher.jsonl plus Unicode edge cases; the Go
 *    port replaces each with a hand-written scanner.
 * 6. internal/domain/testdata/unicode_runs.jsonl: NFKC and toLowerCase on
 *    strings with long runs of combining marks and case-ignorables (past the
 *    30-character bounds of golang.org/x/text: the UAX #15 Stream-Safe
 *    U+034F insertion and the Final_Sigma look-ahead), and the safety,
 *    parser and matcher functions on inputs built from such runs, including
 *    questions that normalise to exactly 299, 300 and 301 code units.
 *
 * Every recorded string is well-formed UTF-16 (no lone surrogate), because
 * a Go string decoded from JSON cannot carry one.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeJson } from './encode';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = (rel: string) => path.join(ROOT, rel);

/** mulberry32, as in probes.parity.ts. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rnd: () => number, xs: readonly T[]): T => {
  const x = xs[Math.floor(rnd() * xs.length)];
  if (x === undefined) throw new Error('pick from an empty list');
  return x;
};

/** Code-unit order, as record.ts sorts. */
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** No lone surrogate: a Go string cannot carry one (it decodes to U+FFFD). */
const wellFormed = (s: string) => !/\p{Cs}/u.test(s);

function assertWellFormed(s: string, what: string): void {
  if (!wellFormed(s)) throw new Error(`${what}: lone surrogate in ${JSON.stringify(s)}`);
}

function writeLines(rel: string, lines: string[]): void {
  mkdirSync(path.dirname(out(rel)), { recursive: true });
  writeFileSync(out(rel), `${lines.join('\n')}\n`);
  console.log(`${rel}: ${lines.length} lines`);
}

/* ------------------------------------------------- 1. V8 RegExp probes */

type ExecResult = { index: number; groups: (string | null)[] } | null;

function execOf(re: RegExp, input: string): ExecResult {
  const m = re.exec(input);
  if (m === null) return null;
  return { index: m.index, groups: [...m].map((g) => (g === undefined ? null : g)) };
}

/** Hand-written probes: one per JS-specific behaviour the Go matcher re-implements. */
const REGEX_PROBES: [source: string, inputs: string[]][] = [
  // alternation order and backtracking into earlier terms
  ['a|ab', ['ab', 'b', '']],
  ['((a)|(ab))((c)|(bc))', ['abc']],
  ['(a|ab)(c|bcd)(d*)', ['abcd']],
  // greedy and lazy quantifiers
  ['a[a-z]{2,4}', ['abcdefghi']],
  ['a[a-z]{2,4}?', ['abcdefghi']],
  ['(aa|aabaac|ba|b|c)*', ['aabaac']],
  ['a*?b', ['aaab', 'b']],
  ['(a+?)(a*)', ['aaa']],
  ['(a{1,3}?)(a*)', ['aaaa']],
  ['x{2,}', ['x', 'xx', 'xxxx']],
  ['x{2}', ['x', 'xxx']],
  ['x{0}y', ['y', 'xy']],
  ['(?:ab){2,3}?c', ['abababc', 'abc']],
  // the empty-iteration check and capture reset of RepeatMatcher
  ['(z)((a+)?(b+)?(c))*', ['zaacbbbcac']],
  ['(a*)*b', ['b', 'aab', 'c']],
  ['(a|)*b', ['aab', 'b']],
  ['(?:)*x', ['x']],
  ['(a*)+', ['b', 'aa']],
  ['(?:a?)*?b', ['ab', 'b']],
  ['(?:(a)|b)+', ['ab', 'ba']],
  ['(?:(a)|(b))*', ['ab', 'ba']],
  ['(a|b)*c', ['ababc']],
  ['(?:a|())*?x', ['aax']],
  // lookahead: atomic, captures kept when positive, dropped when negative
  ['(?=(a+))', ['baaabac']],
  ['(?=(a+))a*b', ['baaabac']],
  ['a(?=b)', ['ab', 'ac']],
  ['a(?!b)', ['ab', 'ac']],
  ['(?!a)\\w', ['ab']],
  ['(?!(a))\\w', ['ab', 'b']],
  ['(?=(\\w+))\\w', ['ab']],
  ['(?=[^"\']{1,5}(?:["\']| mean\\b))x', ['x mean', 'xxxxxx mean', 'x"', 'x meaning']],
  // a failed assertion leaves no captures behind for a later alternative
  ['(?:(?!(a)b)a|ab)', ['ab', 'ac']],
  ['(?:(?=(a))ab|a)', ['ac', 'ab']],
  ['(?:(?<=(a))bc|b)', ['ab', 'abc']],
  ['a(?:(?<!(a))b|b)', ['ab']],
  ['(?:(?!(a)(b))a|a(b))', ['ab']],
  // lookbehind: matched backwards, with greedy captures from the right
  ['(?<=\\$)\\d+', ['cost $42', '42']],
  ['(?<!\\$)\\b\\d+', ['$42 17']],
  ['(?<=(\\d+)(\\d+))$', ['1053']],
  ['(?<=(\\d+?)(\\d+))$', ['1053']],
  ['(?<=([ab]+)([bc]+))$', ['abbc']],
  ['(?<=\\b(?:read|say)\\b.*)again', ['read it again', 'again', 'bread again']],
  [
    '(?<!\\b(?:read|say)\\b.*)\\bagain\\b',
    ['read it again', 'again', 'i read. took it again', 'xread again'],
  ],
  ['(?<=a(?=b)b)c', ['abc', 'ac']],
  ['(?<=(?<!x)a)b', ['ab', 'xab']],
  ['(?<=^a*)b', ['aaab', 'acb']],
  ['(?<=a{2,3})b', ['ab', 'aab', 'aaab']],
  ['(?<=a+?)b', ['aab']],
  ['(?<=(a)|b)c', ['ac', 'bc']],
  ['(?<=\\b\\w+ )x', ['foo x', ' x']],
  ['(?<![\\w./-])\\d+', ['a1', '.5', '7', '-3', ' 42']],
  // word boundaries are ASCII without the u flag
  ['\\bé', ['é', 'aé', ' é']],
  ['\\w+', ['café', 'naïve', 'ǅx']],
  ['\\Bx', ['ax', ' x', 'x']],
  ['\\b', ['', ' ', 'a']],
  ['\\B', ['', ' ', 'a']],
  ['a\\b', ['aé', 'a_', 'a-']],
  // . and line terminators; code units, not code points
  ['^.$', ['\n', '\r', ' ', ' ', '\u0085', 'a', '😀', ' ']],
  ['^..$', ['😀']],
  ['^[^a]$', ['😀', 'é']],
  ['^[^a]{2}$', ['😀']],
  ['^.{3}$', ['a😀', '😀😀']],
  // the quantifier binds to the low surrogate only
  ['😀+', ['😀😀', '😀']],
  // \s is the JS set (Zs, BOM, line terminators), not unicode.IsSpace
  [
    '^\\s$',
    [
      ' ',
      '\t',
      '\n',
      '\v',
      '\f',
      '\r',
      ' ',
      ' ',
      ' ',
      ' ',
      ' ',
      ' ',
      ' ',
      ' ',
      ' ',
      '　',
      '﻿',
      '\u0085',
      '᠎',
      '​',
    ],
  ],
  ['^\\S$', [' ', '\u0085', '᠎', 'x']],
  ['^\\d$', ['٣', '５', '5']],
  ['^\\W$', ['é', '_', '-']],
  // ^ and $ without the m flag
  ['^b', ['a\nb', 'b']],
  ['a$', ['a\nb', 'ba']],
  ['^$', ['', '\n']],
  // Annex B syntax
  ['a{', ['a{']],
  ['a{1', ['a{1']],
  ['a{,2}', ['a{,2}', 'aa']],
  ['a{1,2', ['a{1,2']],
  ['x]', ['x]']],
  ['a}', ['a}']],
  ['[\\w-]', ['-', 'a', '.']],
  ['[\\w./-]+', ['a./-b']],
  ["[\\w'-]+", ["it's-a"]],
  ['[ -]', [' ', '-', '!']],
  ['[- ]', [' ', '-', '!']],
  ['[.-]', ['.', '-', ',']],
  ['[\\-]', ['-']],
  ['\\/', ['/']],
  ['\\.', ['.', 'a']],
  ["\\'", ["'"]],
  ['\\x41\\u0042', ['AB']],
  ['[\\b]', ['\b', 'b']],
  ['\\0', ['\0']],
  ['\\t\\n\\v\\f\\r', ['\t\n\v\f\r']],
  ['[^\\x20-\\x7e]', ['a', 'é', '\u007f', '~']],
  ['[\\s\\S]', ['\n']],
  ['[\\d.]+', ['1.5']],
  ['[µμ]g', ['µg', 'μg', 'Μg']],
  ['[a-z0-9]+', ['Ab9']],
  ['[^"\']+', ['a"b']],
  ['[,.?!;:)]', [')', '(']],
  // the phrase slot shape used by the explain templates
  [
    '^what (?:does|do) (?:the (?:word|term) )?(?:"([^"]*)"|\'([^\']*)\'|(.+?)) mean(?: (?:in (?:simpler|simple) (?:words|terms)|simply))?$',
    [
      'what does "x" mean',
      "what does '' mean",
      'what does the word x y mean in simple words',
      'what does mean mean',
      'what does x mean simply',
    ],
  ],
];

/**
 * Seeded random patterns over a small alphabet, so every combination of
 * quantifier, group, capture, lookaround, anchor and boundary is compared
 * with V8 on short inputs.
 */
function randomPattern(rnd: () => number, depth: number): string {
  const atoms = [
    'a',
    'b',
    ' ',
    '-',
    '.',
    '\\w',
    '\\W',
    '\\s',
    '\\d',
    '[ab]',
    '[^a]',
    '[a-c ]',
    '[\\w-]',
    '1',
  ];
  const n = 1 + Math.floor(rnd() * 3);
  let s = '';
  for (let i = 0; i < n; i++) {
    const r = rnd();
    let term: string;
    if (depth > 0 && r < 0.3) {
      const body =
        rnd() < 0.4
          ? `${randomPattern(rnd, depth - 1)}|${randomPattern(rnd, depth - 1)}`
          : randomPattern(rnd, depth - 1);
      term = `${pick(rnd, ['(', '(?:', '(?=', '(?!', '(?<=', '(?<!'])}${body})`;
    } else if (r < 0.4) {
      term = pick(rnd, ['^', '$', '\\b', '\\B']);
    } else {
      term = pick(rnd, atoms);
    }
    const lookaround = /^\(\?<?[=!]/.test(term);
    const assertion = ['^', '$', '\\b', '\\B'].includes(term);
    if (!lookaround && !assertion && rnd() < 0.45) {
      term += pick(rnd, ['*', '+', '?', '{2}', '{1,2}', '{0,3}', '{2,}']);
      if (rnd() < 0.35) term += '?';
    }
    s += term;
  }
  return s;
}

function v8Probes(): string[] {
  const lines = new Map<string, string>();
  const add = (source: string, input: string) => {
    assertWellFormed(input, source);
    const re = new RegExp(source);
    lines.set(
      JSON.stringify([source, input]),
      encodeJson({ source, input, result: execOf(re, input) }),
    );
  };
  for (const [source, inputs] of REGEX_PROBES) for (const input of inputs) add(source, input);
  const rnd = prng(20261029);
  const alphabet = ['a', 'b', 'c', ' ', '-', '1', '_', 'é'];
  let made = 0;
  while (made < 3000) {
    const source = randomPattern(rnd, 2);
    try {
      new RegExp(source);
    } catch {
      continue;
    }
    made++;
    for (let k = 0; k < 4; k++) {
      let input = '';
      const len = Math.floor(rnd() * 9);
      for (let i = 0; i < len; i++) input += pick(rnd, alphabet);
      add(source, input);
    }
  }
  return [...lines.entries()].sort(([a], [b]) => byCodeUnits(a, b)).map(([, line]) => line);
}

/* ------------------------------------ 3. intercepting the safety RegExps */

const OriginalRegExp = RegExp;
const originalTest = RegExp.prototype.test;
const originalExec = RegExp.prototype.exec;
/** The string a RegExp was constructed from (its `.source` escapes `/`). */
const constructedFrom = new WeakMap<RegExp, string>();
let capturing = false;
const seenPatterns = new Map<RegExp, { source: string; constructed: boolean; exec: boolean }>();
const seenTexts = new Set<string>();

function note(re: RegExp, input: unknown, viaExec: boolean): void {
  if (!capturing || re.flags !== '' || typeof input !== 'string') return;
  const constructed = constructedFrom.get(re);
  const entry = seenPatterns.get(re) ?? {
    source: constructed ?? re.source,
    constructed: constructed !== undefined,
    exec: false,
  };
  if (viaExec) entry.exec = true;
  seenPatterns.set(re, entry);
  seenTexts.add(input);
}

function installInterceptors(): void {
  globalThis.RegExp = new Proxy(OriginalRegExp, {
    construct(target, args: [string | RegExp, string?], newTarget) {
      const re = Reflect.construct(target, args, newTarget) as RegExp;
      if (typeof args[0] === 'string') constructedFrom.set(re, args[0]);
      return re;
    },
  });
  // test() calls exec() internally; only a direct exec() call marks a pattern as exec-used.
  let inTest = false;
  RegExp.prototype.test = function (this: RegExp, s: string) {
    note(this, s, false);
    inTest = true;
    try {
      return originalTest.call(this, s);
    } finally {
      inTest = false;
    }
  };
  RegExp.prototype.exec = function (this: RegExp, s: string) {
    if (!inTest) note(this, s, true);
    return originalExec.call(this, s);
  };
}

function removeInterceptors(): void {
  globalThis.RegExp = OriginalRegExp;
  RegExp.prototype.test = originalTest;
  RegExp.prototype.exec = originalExec;
}

/* --------------------------------------- 2. adversarial safety variants */

const INVISIBLES = [
  '​',
  '‌',
  '‍',
  '⁠',
  '﻿',
  '­',
  '͏',
  '᠎',
  'ᅟ',
  'ᅠ',
  'ㅤ',
  'ﾠ',
  '️',
  '\u{e0001}',
  '\u{e0041}',
  '\u{e0100}',
  '؜',
  '‎',
  '‏',
  '‪',
  '‮',
  '⁦',
  '⁩',
  '⁡',
  '⁤',
  '￹',
  '\u{1d173}',
  '\u{13430}',
  '؀',
  '࢐',
  '\u{110bd}',
  '឴',
  '⁥',
  '\u{1bca0}',
];
const SPACES = [
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  '　',
  '\t',
  '\n',
  '\r',
  ' ',
  ' ',
  '\u0085',
  '᠎',
  ' ',
  '\v',
  '\f',
  '  ',
  ' \t ',
];
/** Look-alikes per ASCII letter: Cyrillic, Greek, fullwidth, maths (NFKC folds some), circled, ligatures. */
const CONFUSABLES: Record<string, string[]> = {
  a: ['а', 'α', 'ａ', '𝐚', 'ⓐ', 'ᵃ', 'à', 'ɑ'],
  c: ['с', 'ϲ', 'ｃ', '𝐜', 'ⅽ', 'ç'],
  d: ['ԁ', 'ｄ', '𝐝', 'ⅾ', 'ⓓ'],
  e: ['е', 'ε', 'ｅ', '𝐞', 'é', 'ⓔ', 'ℯ'],
  h: ['һ', 'ｈ', '𝐡', 'ℎ'],
  i: ['і', 'ι', 'ｉ', '𝐢', 'ı', 'ⅰ', 'İ', 'í', 'ℹ'],
  j: ['ј', 'ｊ', '𝐣'],
  k: ['к', 'κ', 'ｋ', '𝐤', 'K'],
  l: ['ӏ', 'ｌ', '𝐥', 'ⅼ', 'ℓ', 'Ⅼ'],
  m: ['м', 'ｍ', '𝐦', 'ⅿ'],
  n: ['п', 'η', 'ｎ', '𝐧', 'ñ'],
  o: ['о', 'ο', 'ｏ', '𝐨', '０', 'ö', 'ℴ', '⁰'],
  p: ['р', 'ρ', 'ｐ', '𝐩'],
  s: ['ѕ', 'ｓ', '𝐬', 'ſ', 'ś'],
  t: ['т', 'τ', 'ｔ', '𝐭'],
  u: ['υ', 'ｕ', '𝐮', 'ü'],
  v: ['ν', 'ｖ', '𝐯', 'ⅴ'],
  w: ['ѡ', 'ｗ', '𝐰'],
  x: ['х', 'χ', 'ｘ', '𝐱', 'ⅹ'],
  y: ['у', 'γ', 'ｙ', '𝐲'],
};
const LIGATURES: [string, string][] = [
  ['fi', 'ﬁ'],
  ['fl', 'ﬂ'],
  ['ff', 'ﬀ'],
  ['st', 'ﬆ'],
  ['ffi', 'ﬃ'],
];
const APOSTROPHES = ['’', '‘', '‛', '′', '`', 'ʼ', '＇', '´'];
const DOUBLE_QUOTES = ['“', '”', '„', '‟', '″', '＂', '«', '»'];
const PUNCT_RUNS = [
  '?',
  '??',
  '?!',
  '!!!',
  '...',
  '…',
  '?.',
  ' ?',
  ',',
  ';',
  ':',
  '？',
  '！',
  '。',
  '?)',
  '-',
  '—',
  ' ?!.,;: ',
];
const DIGITS: Record<string, string[]> = {
  '0': ['０', '٠', '⁰', '𝟎', '₀'],
  '1': ['１', '١', '¹', '𝟏', '₁', '①'],
  '2': ['２', '٢', '²', '𝟐', '₂', '②'],
  '3': ['３', '٣', '³', '𝟑'],
  '5': ['５', '٥', '⁵', '𝟓'],
  '6': ['６', '٦', '⁶', '𝟔'],
};
const SPECIAL_CASE = ['İ', 'Σ', 'ẞ', 'ǅ', 'ŉ', 'ﬀ', 'Ω', 'K', 'Å', 'ʼn', 'ͅ'];

function randomIndex(rnd: () => number, s: string): number {
  return Math.floor(rnd() * (s.length + 1));
}

/** Inserts at a code-point boundary, never inside a surrogate pair. */
function insertAt(s: string, i: number, piece: string): string {
  let at = i;
  const prev = s.charCodeAt(at - 1);
  if (at > 0 && at < s.length && prev >= 0xd800 && prev <= 0xdbff) at++;
  return s.slice(0, at) + piece + s.slice(at);
}

function replaceRandomMatch(
  rnd: () => number,
  s: string,
  re: RegExp,
  f: (m: string) => string,
): string {
  const hits = [...s.matchAll(re)];
  if (hits.length === 0) return s;
  const hit = pick(rnd, hits);
  const i = hit.index ?? 0;
  return s.slice(0, i) + f(hit[0]) + s.slice(i + hit[0].length);
}

type Mutation = (s: string, rnd: () => number) => string;

const MUTATIONS: [name: string, f: Mutation][] = [
  [
    'random case',
    (s, rnd) => [...s].map((c) => (rnd() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join(''),
  ],
  ['upper', (s) => s.toUpperCase()],
  ['title', (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase())],
  [
    'confusable letter',
    (s, rnd) =>
      replaceRandomMatch(rnd, s, /[a-z]/gi, (c) => {
        const alts = CONFUSABLES[c.toLowerCase()];
        return alts === undefined ? c : pick(rnd, alts);
      }),
  ],
  [
    'all confusables of one letter',
    (s, rnd) => {
      const letter = pick(rnd, Object.keys(CONFUSABLES));
      const alt = pick(rnd, CONFUSABLES[letter] ?? [letter]);
      return s.split(letter).join(alt);
    },
  ],
  [
    'ligature',
    (s, rnd) => {
      const [plain, lig] = pick(rnd, LIGATURES);
      return s.replace(plain, lig);
    },
  ],
  ['invisible in a word', (s, rnd) => insertAt(s, randomIndex(rnd, s), pick(rnd, INVISIBLES))],
  [
    'invisibles everywhere',
    (s, rnd) => [...s].map((c) => c + (rnd() < 0.3 ? pick(rnd, INVISIBLES) : '')).join(''),
  ],
  ['space variant', (s, rnd) => s.replace(/ /g, () => (rnd() < 0.5 ? pick(rnd, SPACES) : ' '))],
  ['one space variant', (s, rnd) => replaceRandomMatch(rnd, s, / /g, () => pick(rnd, SPACES))],
  ['apostrophe', (s, rnd) => s.replace(/'/g, () => pick(rnd, APOSTROPHES))],
  ['double quote', (s, rnd) => s.replace(/"/g, () => pick(rnd, DOUBLE_QUOTES))],
  [
    'quote a word',
    (s, rnd) =>
      replaceRandomMatch(rnd, s, /[a-z]+(?: [a-z]+)?/gi, (w) => {
        const q = pick(rnd, ['"', "'", '“', '‘']);
        const close = q === '“' ? '”' : q === '‘' ? '’' : q;
        return `${q}${w}${close}`;
      }),
  ],
  ['trailing punctuation', (s, rnd) => s.replace(/[?.!]*$/, pick(rnd, PUNCT_RUNS))],
  ['leading punctuation', (s, rnd) => pick(rnd, ['?', '¿', '"', '...', '-', '(', '* ', '> ']) + s],
  [
    'inner punctuation',
    (s, rnd) =>
      replaceRandomMatch(rnd, s, / /g, () =>
        pick(rnd, [', ', ' - ', '; ', ' — ', '. ', '... ', '/', '-', '_']),
      ),
  ],
  [
    'digit variant',
    (s, rnd) => replaceRandomMatch(rnd, s, /[012356]/g, (d) => pick(rnd, DIGITS[d] ?? [d])),
  ],
  [
    'number word to digit',
    (s, rnd) => s.replace(/\b(?:two|three|one)\b/i, pick(rnd, ['2', '3', '1', '２', '𝟐'])),
  ],
  [
    'combining mark',
    (s, rnd) =>
      insertAt(
        s,
        1 + Math.floor(rnd() * Math.max(1, s.length - 1)),
        pick(rnd, ['́', '̈', '̇', '̸', '⃝']),
      ),
  ],
  ['special case letter', (s, rnd) => insertAt(s, randomIndex(rnd, s), pick(rnd, SPECIAL_CASE))],
  [
    'emoji',
    (s, rnd) =>
      insertAt(s, randomIndex(rnd, s), pick(rnd, ['🙂', '💊', '👶', '😀', '🇵🇭', '❤️', '#️⃣'])),
  ],
  [
    'padding',
    (s, rnd) => pick(rnd, ['  ', '\t', '\n', '　', '​ ']) + s + pick(rnd, ['  ', '\n', ' ​', '﻿']),
  ],
  ['double a word', (s, rnd) => replaceRandomMatch(rnd, s, /[a-z]+/gi, (w) => `${w} ${w}`)],
  [
    'filler words',
    (s, rnd) =>
      replaceRandomMatch(rnd, s, / /g, () =>
        pick(rnd, [' please ', ' um ', ' like ', ' just ', ' really ', ' ok ']),
      ),
  ],
  ['drop a space', (s, rnd) => replaceRandomMatch(rnd, s, / /g, () => '')],
  [
    'hyphenate',
    (s, rnd) => replaceRandomMatch(rnd, s, / /g, () => pick(rnd, ['-', '‐', '‑', '‒', '–', '−'])),
  ],
  [
    'repeat to the limit',
    (s, rnd) => {
      const target = pick(rnd, [298, 299, 300, 301, 302, 320]);
      let t = s;
      while (t.length < target) t += ` ${s}`;
      return t.slice(0, target).replace(/[\ud800-\udbff]$/, '');
    },
  ],
  [
    'astral at the limit',
    (s, rnd) => {
      const base =
        s.length >= 296 ? s.slice(0, 296) : s + ' x'.repeat(Math.floor((296 - s.length) / 2));
      return base.replace(/[\ud800-\udbff]$/, '') + pick(rnd, ['😀', '𝟐', '𝐚𝐛', ' 💊', 'é', '  ']);
    },
  ],
];

function adversarialQuestions(base: string[]): string[] {
  const rnd = prng(20261030);
  const qs = new Set<string>();
  for (const b of base) {
    for (let v = 0; v < 3; v++) {
      let q = b;
      const steps = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < steps; k++) q = pick(rnd, MUTATIONS)[1](q, rnd);
      if (wellFormed(q)) qs.add(q);
    }
  }
  // long inputs: past the limit before and after normalisation
  const longs = [
    'a'.repeat(10_000),
    'Can you read this label? '.repeat(400),
    'white round pill take dose '.repeat(371),
    '​'.repeat(5000) + 'Can you read this label?',
    ' '.repeat(5000) + 'What is the brand name?' + '?'.repeat(5000),
    '𝐚'.repeat(301),
    '𝐚'.repeat(300),
    `${'x'.repeat(299)}😀`,
    `${'x'.repeat(298)}😀`,
    `what does ${'"a" '.repeat(70)}mean`,
    `what does ${'word '.repeat(55)}mean`,
    `${'white label read '.repeat(17)}pill`,
    `${'read '.repeat(50)}${'again '.repeat(8)}`,
    `what does "${'keep dry '.repeat(40)}" mean`,
    `${'i took '.repeat(40)}`,
    `${'my baby '.repeat(37)}`,
    `${'too much '.repeat(33)}`,
    `${'more than '.repeat(30)}`,
    'how many '.repeat(33),
  ];
  for (const q of longs) qs.add(q);
  return [...qs];
}

/* ------------------------------------------------- 4. Unicode tables */

type Range = [number, number];

function ranges(test: (cp: number) => boolean): Range[] {
  const rs: Range[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (!test(cp)) continue;
    const last = rs[rs.length - 1];
    if (last !== undefined && last[1] === cp - 1) last[1] = cp;
    else rs.push([cp, cp]);
  }
  return rs;
}

function unicodeTables(): object {
  const ch = (cp: number) => String.fromCodePoint(cp);
  const lower: Record<string, string> = {};
  const nfkc: Record<string, string> = {};
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = ch(cp);
    const l = c.toLowerCase();
    if (l !== c) lower[cp.toString(16)] = l;
    const n = c.normalize('NFKC');
    if (n !== c) nfkc[cp.toString(16)] = n;
  }
  return {
    node: process.version,
    unicode: process.versions.unicode,
    jsSpace: ranges((cp) => /^\s$/.test(ch(cp))),
    cf: ranges((cp) => /\p{Cf}/u.test(ch(cp))),
    letter: ranges((cp) => /\p{L}/u.test(ch(cp))),
    number: ranges((cp) => /\p{N}/u.test(ch(cp))),
    dashPunctuation: ranges((cp) => /\p{Pd}/u.test(ch(cp))),
    invisible: ranges((cp) => /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(ch(cp))),
    lower,
    nfkc,
    cased: ranges((cp) => /\p{Cased}/u.test(ch(cp))),
    caseIgnorable: ranges((cp) => /\p{Case_Ignorable}/u.test(ch(cp))),
    sigmaFinal: sigmaFinalTables(),
  };
}

/**
 * toLowerCase's Final_Sigma context, per code point: for each template (`c`
 * stands for the code point), the code points for which V8 lowercases the Σ
 * to the final form ς. The Σ is the second character of the `AΣ…`
 * templates and the last of the others.
 */
function sigmaFinalTables(): Record<string, Range[]> {
  const ch = (cp: number) => String.fromCodePoint(cp);
  const tables: Record<string, Range[]> = {};
  for (const template of ['AΣc', 'AΣcA', 'cΣ', 'AcΣ']) {
    tables[template] = ranges((cp) => {
      const lower = template.replace('c', ch(cp)).toLowerCase();
      const sigma = template.startsWith('AΣ') ? lower.charAt(1) : lower.charAt(lower.length - 1);
      if (sigma !== 'σ' && sigma !== 'ς') throw new Error(`no sigma in ${template}`);
      return sigma === 'ς';
    });
  }
  return tables;
}

/* --------------------------- 6. long non-starter and case-ignorable runs */

/**
 * golang.org/x/text bounds two contexts at 30 characters where ICU, and so
 * V8, has no bound: its NFKC follows the UAX #15 Stream-Safe Text Format (a
 * U+034F after 30 non-starters, which blocks canonical reordering and
 * composition), and its Final_Sigma look-ahead stops after 30
 * case-ignorables. These probes cross both bounds.
 */
const RUN_MARKS = [
  '̖', // ccc 220
  '́', // ccc 230
  '̧', // ccc 202
  '̛', // ccc 216
  'ͅ', // ccc 240
  '̸', // ccc 1
  'ְ', // ccc 10
  'ً', // ccc 27
  '़', // ccc 7
  '゙', // ccc 8
  '̕', // ccc 232
  '͜', // ccc 233
  '͝', // ccc 234
  '̣', // ccc 220
  '̈', // ccc 230
  '̄', // ccc 230
  '͂', // ccc 230
  '̓', // ccc 230
  'ཱ', // ccc 129
  'ི', // ccc 130
  '᷎', // ccc 214
  '̈́', // NFKC: U+0308 U+0301
  'ཱི', // NFKC: U+0F71 U+0F72
];
/** Starters that compose with marks or with each other, and compatibility characters. */
const RUN_STARTERS = [
  'a',
  'e',
  'o',
  'u',
  'A',
  'i',
  's',
  'x',
  '1',
  ' ',
  'α',
  'ω',
  'η',
  'ι',
  'Ω',
  'Σ',
  'ᄀ', // Hangul choseong, jungseong, jongseong, a syllable and compatibility jamo
  'ᅡ',
  'ᆨ',
  '가',
  'ㄱ',
  'ㅏ',
  'ে', // Bengali two-part vowel: starter + starter
  'া',
  'ﬁ',
  '½',
  '¨',
  '΅',
  'K',
  'Å',
];
/** Case-ignorable characters; U+02B0 and U+0345 are cased as well. */
const RUN_IGNORABLES = [
  "'",
  '.',
  ':',
  '·',
  'ʰ',
  'ͅ',
  '́',
  '­',
  'ˆ',
  '’',
  '‘',
  '︓',
  '״',
  '՟',
  '·',
  '​',
];

function runNfkcStrings(rnd: () => number): string[] {
  const ss = new Set<string>();
  const pairs: [low: string, high: string][] = [
    ['̖', '́'],
    ['̧', '́'],
    ['́', 'ͅ'],
    ['ְ', '́'],
    ['̸', '̈'],
  ];
  for (const n of [1, 2, 28, 29, 30, 31, 32, 33, 40, 60, 61, 64, 100, 300]) {
    for (const [low, high] of pairs) {
      ss.add(`a${low.repeat(n)}${high}`);
      ss.add(`a${high.repeat(n)}${low}`);
      ss.add(`${low.repeat(n)}${high}`);
      ss.add(`a${low.repeat(n)}${high}b${high}`);
    }
    ss.add(`ᄀ${'̖'.repeat(n)}ᅡ`);
    ss.add(`a${'̈́'.repeat(n)}`);
    ss.add(`ཀ${'ཱི'.repeat(n)}`);
    ss.add(`ω${'̓'.repeat(n)}ͅ`);
  }
  for (let i = 0; i < 400; i++) {
    let s = '';
    const segments = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < segments; k++) {
      if (rnd() < 0.85) s += pick(rnd, RUN_STARTERS);
      const len = pick(rnd, [0, 1, 2, 3, 5, 29, 30, 31, 32, 35, 45, 70]);
      if (rnd() < 0.5) for (let j = 0; j < len; j++) s += pick(rnd, RUN_MARKS);
      else s += pick(rnd, RUN_MARKS).repeat(len) + pick(rnd, RUN_MARKS);
    }
    ss.add(s);
  }
  return [...ss];
}

function runLowerStrings(rnd: () => number): string[] {
  const ss = new Set<string>();
  for (const n of [0, 1, 29, 30, 31, 32, 64]) {
    for (const ign of RUN_IGNORABLES) {
      const run = ign.repeat(n);
      ss.add(`AΣ${run}A`);
      ss.add(`AΣ${run}`);
      ss.add(`A${run}Σ`);
      ss.add(`${run}Σ`);
      ss.add(`AΣ${run} `);
      ss.add(`A${run}Σ${run}A`);
    }
  }
  const pool = ['Σ', 'Α', 'a', 'x', ' ', '1', 'ǅ', ...RUN_IGNORABLES];
  for (let i = 0; i < 300; i++) {
    let s = '';
    const pieces = 1 + Math.floor(rnd() * 6);
    for (let k = 0; k < pieces; k++) {
      s += pick(rnd, pool).repeat(pick(rnd, [1, 1, 2, 29, 30, 31, 32, 40]));
    }
    ss.add(s);
  }
  return [...ss];
}

/** The safety gate's normalisation, only to place a question at an exact normalised length. */
const gateLength = (q: string) =>
  q
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim().length;

function runQuestions(): string[] {
  const heads = [
    'my baby swallowed some pills ',
    'i took too much ',
    'how many should i take ',
    'is it safe for my son ',
    'can i drink alcohol with this ',
    'can you read this label ',
  ];
  const combining = `a${'̖'.repeat(30)}́`;
  const runs = [
    combining,
    `a${'́'.repeat(30)}̖`,
    `ΑΣ${"'".repeat(31)}Α`,
    `a${'̖'.repeat(64)}́`,
    [combining, combining, combining].join(' '),
  ];
  const qs = new Set<string>();
  for (const head of heads) {
    for (const run of runs) {
      for (const target of [299, 300, 301]) {
        for (const where of ['end', 'start']) {
          for (let k = 0; ; k++) {
            const pad = 'x'.repeat(k);
            const q = where === 'end' ? `${head}${pad} ${run}` : `${run} ${head}${pad}`;
            if (gateLength(q) < target) continue;
            if (gateLength(q) !== target) throw new Error(`cannot place ${JSON.stringify(q)}`);
            qs.add(q);
            break;
          }
        }
      }
    }
  }
  for (const n of [29, 30, 31, 32, 40]) {
    const sigma = `ΑΣ${"'".repeat(n)}Α`;
    qs.add(`What does "${sigma}" mean?`);
    qs.add(`what does the word ${sigma} mean`);
    qs.add(`What does "a${'́'.repeat(n)}̖" mean?`);
    qs.add(`what does a${'̖'.repeat(n)}́ mean`);
    qs.add(`What does "Σ${'́'.repeat(n)}" mean?`);
  }
  qs.add('what does "ʰΣ" mean');
  qs.add('what does "xʰΣ" mean');
  return [...qs];
}

async function unicodeRunProbes(
  safety: typeof import('../../apps/server/src/domain/safety'),
): Promise<string[]> {
  const parsers = await import('../../apps/server/src/domain/parsers');
  const matcher = await import('../../apps/server/src/domain/matcher');
  const rnd = prng(20261031);
  const lines = new Map<string, string>();
  const add = (fn: string, args: unknown[], result: unknown) => {
    for (const a of args) if (typeof a === 'string') assertWellFormed(a, fn);
    lines.set(`${fn}\u0000${JSON.stringify(args)}`, encodeJson({ fn, args, result }));
  };
  for (const s of runNfkcStrings(rnd)) add('nfkc', [s], s.normalize('NFKC'));
  for (const s of runLowerStrings(rnd)) add('lower', [s], s.toLowerCase());
  for (const q of runQuestions()) {
    add('classifyQuestion', [q], safety.classifyQuestion(q));
    add('extractExplainPhrase', [q], safety.extractExplainPhrase(q));
    add('askedFields', [q], safety.askedFields(q));
  }

  const names = ['ʰΣ', 'x ʰΣ', 'ͅΣ Tablet'];
  const strengths: string[] = [];
  for (const n of [29, 30, 31, 32, 40]) {
    names.push(`ΑΣ${"'".repeat(n)}Α`, `ΑΣ${"'".repeat(n)}Α Tablet`);
    names.push(`BΣ${'́'.repeat(n)} Capsule`);
    strengths.push(`500 m${'̖'.repeat(n)}g`, `500 mg a${'̖'.repeat(n)}́`);
    strengths.push(`5${'́'.repeat(n)}̖ mg`, `500 ㎎${'̖'.repeat(n)}`);
  }
  // a mark after 30 others still composes with the letter before the run
  // in ICU (g + U+0301 is U+01F5), which x/text's U+034F prevented
  for (const base of ['500 mg', '250 mg/5 mL', '0.5 g', '100 IU']) {
    const units = [...base];
    for (let i = 1; i <= units.length; i++) {
      for (const mark of ['́', '̇']) {
        const run = '̖'.repeat(30) + mark;
        strengths.push(units.slice(0, i).join('') + run + units.slice(i).join(''));
      }
    }
  }
  for (const s of names) add('normalizeName', [s], parsers.normalizeName(s));
  for (const s of strengths) add('parseStrength', [s], parsers.parseStrength(s));

  // assessMatch: a verified corpus case whose brand or dosage form differs
  // between the pack and the record only inside a long run
  type Label = Parameters<typeof matcher.assessMatch>[0];
  type Search = Parameters<typeof matcher.assessMatch>[1];
  const verified = readFileSync(out('fixtures/parity/matcher.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { fn: string; args: [Label, Search]; result: unknown })
    .find((c) => {
      if (c.fn !== 'assessMatch' || c.args[1].kind !== 'ok') return false;
      const keys = c.args[0].fields.map((f) => f.key);
      return (
        (c.result as { status: string }).status === 'verified' &&
        c.args[1].records.length === 1 &&
        keys.includes('brandName') &&
        keys.includes('dosageForm')
      );
    });
  if (verified === undefined) throw new Error('no verified assessMatch case in matcher.jsonl');
  const variant = (labelValue: [string, string], recordValue?: [string, string]) => {
    const [label, search] = structuredClone(verified.args);
    const field = label.fields.find((f) => f.key === labelValue[0]);
    if (field === undefined || search.kind !== 'ok' || search.records[0] === undefined) {
      throw new Error('unexpected verified case shape');
    }
    field.value = labelValue[1];
    if (recordValue !== undefined) {
      const record = search.records[0] as unknown as Record<string, string>;
      record[recordValue[0]] = recordValue[1];
    }
    add('assessMatch', [label, search], matcher.assessMatch(label, search));
  };
  for (const n of [29, 30, 31, 32, 40]) {
    const ticks = "'".repeat(n);
    variant(['brandName', `ΑΣ${ticks}Α`], ['brandName', `ασ${ticks}α`]);
    variant(['brandName', `ΑΣ${ticks}Α`], ['brandName', `ας${ticks}α`]);
    const form = `a${'̖'.repeat(n)}́ Tablet`;
    variant(['dosageForm', form], ['strengthForm', `500 mg á${'̖'.repeat(n)} Tablet`]);
    variant(['dosageForm', form], ['strengthForm', `500 mg a Tablet`]);
  }
  variant(['brandName', 'ʰΣ'], ['brandName', 'ʰσ']);
  variant(['brandName', 'ʰΣ'], ['brandName', 'ʰς']);
  // the pack's dosage form followed by a run whose last mark composes with
  // its last letter in ICU (capsule + U+0301, tablet + U+0307), so the form
  // word is no longer the form; x/text's U+034F kept it
  const packForm = verified.args[0].fields.find((f) => f.key === 'dosageForm')?.value ?? '';
  for (const n of [29, 30, 31]) {
    for (const mark of ['̀', '́', '̇', '̈', '̧', '̌']) {
      const form = `${packForm}${'̖'.repeat(n)}${mark}`;
      variant(['dosageForm', form]);
    }
  }
  return [...lines.entries()].sort(([a], [b]) => byCodeUnits(a, b)).map(([, l]) => l);
}

/* ---------------------------------------------------------------- main */

async function main(): Promise<void> {
  writeLines('internal/jsregex/testdata/v8_probes.jsonl', v8Probes());

  installInterceptors();
  const safety = await import('../../apps/server/src/domain/safety');

  const corpus = readFileSync(out('fixtures/parity/safety.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { fn: string; args: unknown[] });
  const base = [
    ...new Set(
      corpus
        .filter((c) => c.fn === 'classifyQuestion' && typeof c.args[0] === 'string')
        .map((c) => c.args[0] as string),
    ),
  ].sort(byCodeUnits);
  const questions = adversarialQuestions(base);
  const recorded = new Set(questions);

  const lines = new Map<string, string>();
  capturing = true;
  // the corpus questions too, so every pattern is seen on them
  for (const q of [...base, ...questions]) {
    const results: [string, unknown][] = [
      ['classifyQuestion', safety.classifyQuestion(q)],
      ['extractExplainPhrase', safety.extractExplainPhrase(q)],
      ['askedFields', safety.askedFields(q)],
    ];
    for (const [fn, result] of results) {
      assertWellFormed(q, fn);
      if (!recorded.has(q)) continue;
      const line = encodeJson({ fn, args: [q], result });
      lines.set(`${fn}\u0000${JSON.stringify([q])}`, line);
    }
  }
  capturing = false;
  removeInterceptors();
  writeLines(
    'internal/domain/testdata/safety_adversarial.jsonl',
    [...lines.entries()].sort(([a], [b]) => byCodeUnits(a, b)).map(([, l]) => l),
  );

  const texts = [...seenTexts].sort(byCodeUnits);
  for (const t of texts) assertWellFormed(t, 'text');
  const bySource = new Map<
    string,
    { source: string; constructed: boolean; exec: boolean; re: RegExp }
  >();
  for (const [re, e] of seenPatterns) {
    const prev = bySource.get(e.source);
    bySource.set(e.source, { ...e, exec: e.exec || (prev?.exec ?? false), re });
  }
  const patterns = [...bySource.values()].sort((a, b) => byCodeUnits(a.source, b.source));
  const hex = (bits: boolean[]) => {
    let s = '';
    for (let i = 0; i < bits.length; i += 4) {
      let nibble = 0;
      for (let j = 0; j < 4; j++) if (bits[i + j] === true) nibble |= 8 >> j;
      s += nibble.toString(16);
    }
    return s;
  };
  const regexps = {
    note: 'Generated by scripts/parity/go-probes.ts; do not edit.',
    texts,
    patterns: patterns.map((p) => ({
      source: p.source,
      constructed: p.constructed,
      test: hex(texts.map((t) => originalTest.call(new OriginalRegExp(p.source), t))),
    })),
    exec: patterns
      .filter((p) => p.exec)
      .map((p) => ({
        source: p.source,
        results: texts.map((t) => execOf(new OriginalRegExp(p.source), t)),
      })),
  };
  writeFileSync(
    out('internal/domain/testdata/safety_regexps.json'),
    `${JSON.stringify(regexps)}\n`,
  );
  console.log(
    `internal/domain/testdata/safety_regexps.json: ${patterns.length} patterns (${patterns.filter((p) => p.exec).length} exec), ${texts.length} texts`,
  );

  writeFileSync(
    out('internal/domain/testdata/js_unicode.json'),
    `${JSON.stringify(unicodeTables())}\n`,
  );
  console.log('internal/domain/testdata/js_unicode.json: written');

  writeLines('internal/domain/testdata/matcher_regexps.jsonl', matcherRegexpProbes());

  writeLines('internal/domain/testdata/unicode_runs.jsonl', await unicodeRunProbes(safety));
}

/* ------------------------------------- 5. the matcher's flagged RegExps */

/**
 * The matcher's RegExps that carry the i or u flag. The Go port replaces
 * each with a hand-written scanner; these are V8's results on every string
 * value in fixtures/parity/matcher.jsonl plus Unicode edge cases. Each
 * literal must appear verbatim in matcher.ts, so a copy here cannot drift.
 */
const MATCHER_REGEXPS = {
  nameSplit: /\+|,|\band\b/i,
  gluedStrength: /^\p{N}+(\p{L}+)$/u,
  filmCoated: /film[\s\p{Pd}]*coated/gu,
  formSplit: /[^\p{L}\p{N}-]+/u,
  letter: /\p{L}/u,
  format: /\p{Cf}/u,
};

const MATCHER_EXTRA = [
  '',
  '500mg',
  '５００ｍｇ',
  '²mg',
  'mg500',
  '500',
  '500mg5',
  'ⅻmg',
  '٥٠٠mg',
  '500µg',
  '500mgé',
  '5mL',
  '10s',
  '𝟓𝟎𝟎mg',
  '500mg​',
  '500ｍｇ',
  'film coated',
  'film–coated',
  'film—coated',
  'film coated',
  'filmcoated',
  'film - coated',
  'film_coated',
  'film‐coated',
  'film coated',
  'film\u0085coated',
  'FILM COATED',
  'film coated film coated',
  'filmfilm coated',
  'film  \t coated tablet',
  'film-—coated',
  'film　coated',
  'film﻿coated',
  'film᠎coated',
  '  tablet ',
  'eye-drops',
  '500mg-capsule',
  'tab​let',
  'cap­sule',
  'tablet⁠',
  'paracetamol and caffeine',
  'PARACETAMOL AND CAFFEINE',
  'Sandoz',
  'and',
  'a+b,c',
  'brand',
  'x_and_y',
  'x-and-y',
  'ANDROGEN',
  'and/or',
  'Ascorbic Acid + Zinc',
  'paracetamol and caffeine',
  'paracetamol And caffeine',
  'paracetamol ａｎｄ caffeine',
  'paracetamol ÅND caffeine',
  'paracetamol éand caffeine',
  'paracetamol and2 caffeine',
  'x,,y++z',
  ' and ',
  'AnD',
  'b and',
  'and b',
  'İand',
  'sand and sandals',
  '+',
  ',',
  'tablet/capsule',
  'tablet (film)',
  'Ovule',
  'Effervescent Tablet',
  'Eye Drops',
  'Nasal Spray 0.05%',
  '250 mg/5 mL Suspension',
  '😀tablet',
  'tablet😀',
  'ǅtablet',
  'Ⅻ',
  '½tablet',
  'tablet½',
  'x²',
  'µ',
  'ｔａｂｌｅｔ',
  'TABLET',
  'Tab-let',
  '-',
  '--',
  'a-',
];

function matcherRegexpProbes(): string[] {
  const source = readFileSync(out('apps/server/src/domain/matcher.ts'), 'utf8');
  for (const [name, re] of Object.entries(MATCHER_REGEXPS)) {
    if (!source.includes(re.toString())) throw new Error(`${name}: ${re} is not in matcher.ts`);
  }
  const corpus = readFileSync(out('fixtures/parity/matcher.jsonl'), 'utf8');
  const strings = new Set<string>(MATCHER_EXTRA);
  const collect = (v: unknown): void => {
    if (typeof v === 'string') strings.add(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v !== null && typeof v === 'object') Object.values(v).forEach(collect);
  };
  for (const line of corpus.split('\n'))
    if (line !== '') collect((JSON.parse(line) as { args: unknown }).args);
  const lines = new Map<string, string>();
  const add = (fn: string, s: string, result: unknown) => {
    assertWellFormed(s, fn);
    lines.set(`${fn}\u0000${JSON.stringify(s)}`, encodeJson({ fn, args: [s], result }));
  };
  for (const s of strings) {
    if (!wellFormed(s)) continue;
    const r = MATCHER_REGEXPS;
    add('nameSplit', s, s.split(r.nameSplit));
    add('gluedStrength', s, r.gluedStrength.exec(s)?.[1] ?? null);
    add('filmCoated', s, s.replace(r.filmCoated, 'film-coated'));
    add('formSplit', s, s.split(r.formSplit));
    add('letter', s, r.letter.test(s));
    add('format', s, r.format.test(s));
  }
  return [...lines.entries()].sort(([a], [b]) => byCodeUnits(a, b)).map(([, l]) => l);
}

await main();
