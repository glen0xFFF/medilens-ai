/**
 * Records the question length limits of the explain route for the Go port
 * (task G7 review round 1):
 *
 *   npx tsx scripts/parity/record-question-limits.ts
 *
 * Writes fixtures/parity/explain/question-limits.jsonl, corpus-format lines
 * sorted by fn, then by the args JSON text:
 *
 * - `ExplainRequestSchema`: `ExplainRequestSchema.safeParse({question})`
 *   (packages/contracts, `z.string().trim().min(1).max(300)`, zod 4.6.7) over
 *   boundary questions. `result` is `{success: true, question}` with the
 *   trimmed question the schema outputs, or `{success: false}`. zod measures
 *   a string in Unicode code points: a surrogate pair counts once and a lone
 *   surrogate counts as one. The probes sit on both sides of 300 in code
 *   points and in UTF-16 code units: ASCII, BMP CJK, emoji, CJK Ext-B,
 *   combining marks, lone and reversed surrogates, and JS-trim whitespace.
 * - `explainQuestion`: for every question the schema accepts, Node's
 *   explainQuestion on each demo scenario result, as the route runs it: the
 *   trimmed question, analyzeScenario's result, the fixture answerer, no live
 *   answerer. `args` is `[{scenarioId}, question]` (the scenario id stands
 *   for analyzeScenario's result) and `result` is the answer.
 *
 * Lone surrogates are written as JSON \u escapes (well-formed
 * JSON.stringify). A JSON decoder in Go reads them as U+FFFD, as it reads a
 * request body with the same escape, and U+FFFD counts as one code point, as
 * the lone surrogate does in zod.
 *
 * Nothing touches the network. All label data is the synthetic DEMO DATA of
 * the demo scenarios. After the Node server is removed (task G12),
 * re-recording needs `git checkout node-fallback-v1` first (ruling R4).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExplainRequestSchema } from '@medilens/contracts';
import { DEMO_SCENARIOS } from '../../apps/server/src/demo/scenarios';
import { analyzeScenario } from '../../apps/server/src/pipeline/analyze';
import { explainQuestion } from '../../apps/server/src/pipeline/explain';
import { createResultStore } from '../../apps/server/src/pipeline/store';
import {
  FixtureAnswerer,
  FixtureLabelReader,
  FixtureReferenceProvider,
} from '../../apps/server/src/providers/fixture';
import { encodeJson } from './encode';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'fixtures/parity/explain');

/** The fixed clock of the HTTP tests (apps/server/test/http/helpers.ts T0). */
const T0 = Date.parse('2026-10-27T08:00:00.000Z');

const EMOJI = '\u{1F600}'; // two UTF-16 units, one code point
const EXT_B = '\u{20000}'; // CJK Ext-B: two units, one code point
const HAN = '\u6f22'; // BMP CJK: one unit, one code point
const HIGH = '\uD83D'; // a lone high surrogate
const LOW = '\uDE00'; // a lone low surrogate
const ACUTE = 'e\u0301'; // two code points, no normalization in zod

const x = (n: number): string => 'x'.repeat(n);
const emoji = (n: number): string => EMOJI.repeat(n);

const QUESTIONS: string[] = [
  // empty after the JS trim
  '',
  ' ',
  '   ',
  ' \t',
  '\t\n\r\v\f',
  '\u00a0',
  '\u1680',
  '\u2000\u200a',
  '\u2028\u2029',
  '\u202f\u205f\u3000',
  '\ufeff',
  // not trimmed by JS: one code point each
  '\u200b',
  '\u180e',
  // short questions
  'x',
  '  x  ',
  'What strength is printed here?',
  '  What strength?  ',
  // ASCII around 300
  x(299),
  x(300),
  x(301),
  '  ' + x(300) + '  ',
  '\u3000' + x(300) + '\ufeff',
  '  ' + x(301) + '  ',
  // emoji: 2n units, n code points
  emoji(1),
  emoji(149),
  emoji(150),
  emoji(151),
  emoji(299),
  emoji(300),
  emoji(301),
  ' ' + emoji(151) + ' ',
  ' ' + emoji(300) + ' ',
  '\u2028' + emoji(300) + '\u2029',
  ' ' + emoji(301) + ' ',
  // mixed: one astral character either side of 300
  x(299) + EMOJI,
  x(300) + EMOJI,
  EMOJI + x(299),
  EMOJI + x(300),
  // CJK Ext-B and BMP CJK
  EXT_B.repeat(300),
  EXT_B.repeat(301),
  HAN.repeat(300),
  HAN.repeat(301),
  // combining marks are counted, not composed
  ACUTE.repeat(150),
  ACUTE.repeat(151),
  // lone and reversed surrogates
  HIGH,
  HIGH.repeat(300),
  HIGH.repeat(301),
  LOW.repeat(301),
  (LOW + HIGH).repeat(151),
  emoji(150) + HIGH,
  emoji(299) + HIGH + LOW + HIGH,
  x(300) + HIGH,
  // allowed or refused questions padded with emoji to 300 code points
  'What strength is printed here? ' + emoji(269),
  'What strength is printed here? ' + emoji(270),
  'Can you repeat that? ' + emoji(279),
  'My child swallowed the whole bottle ' + emoji(264),
  'My child swallowed the whole bottle ' + emoji(265),
];

function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

interface Line {
  fn: string;
  args: unknown[];
  result: unknown;
}

async function main(): Promise<void> {
  const store = createResultStore(() => T0);
  const deps = {
    reader: new FixtureLabelReader(),
    references: new FixtureReferenceProvider(),
    store,
    now: () => T0,
    newId: () => 'question-limits',
    isDemo: true,
  };
  const results = [];
  for (const scenario of DEMO_SCENARIOS) {
    results.push({ scenarioId: scenario.id, result: await analyzeScenario(scenario.id, deps) });
  }
  const explainDeps = {
    fixture: new FixtureAnswerer(),
    live: undefined,
    liveBudgetExhausted: () => false,
  };

  const lines: Line[] = [];
  let accepted = 0;
  for (const question of QUESTIONS) {
    const parsed = ExplainRequestSchema.safeParse({ question });
    lines.push({
      fn: 'ExplainRequestSchema',
      args: [{ question }],
      result: parsed.success ? { success: true, question: parsed.data.question } : { success: false },
    });
    if (!parsed.success) continue;
    accepted++;
    for (const { scenarioId, result } of results) {
      const answer = await explainQuestion(result, parsed.data.question, explainDeps);
      lines.push({ fn: 'explainQuestion', args: [{ scenarioId }, parsed.data.question], result: answer });
    }
  }

  // The probes must straddle the limit in both units, or the corpus pins nothing.
  const over = QUESTIONS.filter((q) => q.trim().length > 300);
  const acceptedOverUnits = over.filter((q) => ExplainRequestSchema.safeParse({ question: q }).success);
  const rejectedAtCodePoints = QUESTIONS.filter(
    (q) => codePoints(q.trim()) === 301 && !ExplainRequestSchema.safeParse({ question: q }).success,
  );
  if (acceptedOverUnits.length === 0 || rejectedAtCodePoints.length === 0) {
    throw new Error('the probes do not straddle the 300 code point limit');
  }

  const keyed = new Map<string, string>();
  for (const line of lines) {
    const key = line.fn + '\u0000' + encodeJson(line.args);
    const text = encodeJson(line);
    const seen = keyed.get(key);
    if (seen !== undefined && seen !== text) throw new Error(`two results for ${key}`);
    keyed.set(key, text);
  }
  const sorted = [...keyed.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, t]) => t);

  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'question-limits.jsonl'), sorted.join('\n') + '\n');
  console.log(
    `question limits: ${QUESTIONS.length} questions, ${accepted} accepted, ` +
      `${acceptedOverUnits.length} accepted over 300 UTF-16 units, ` +
      `${sorted.length - QUESTIONS.length} explainQuestion lines over ${results.length} scenarios`,
  );
}

await main();
