/**
 * npm run parity:record — records the parity corpora fixtures/parity/*.jsonl
 * from the Node build (Go port spec §6; rulings R3, R8).
 *
 * 1. Runs the whole server vitest suite plus scripts/parity/probes.parity.ts
 *    under scripts/parity/vitest.config.ts, whose setup file wraps every
 *    exported domain function and writes raw cases to a temp dir.
 * 2. Merges the raw files per corpus: dedupe on fn + args (the same call must
 *    always give the same result, or this fails), sort by fn then args, and
 *    write one JSON object per line, LF endings.
 * 3. Checks that every exported domain function has at least one case and
 *    that all 8 demo scenarios were recorded, prints the counts, and fails if
 *    a corpus is over 20 MB.
 *
 * Changes no production behaviour. Deterministic: re-recording on the same
 * source gives byte-identical corpora.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as answers from '../../apps/server/src/domain/answers';
import * as matcher from '../../apps/server/src/domain/matcher';
import * as parsers from '../../apps/server/src/domain/parsers';
import * as safety from '../../apps/server/src/domain/safety';
import * as summary from '../../apps/server/src/domain/summary';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const server = join(repo, 'apps/server');
const outDir = join(repo, 'fixtures/parity');
const MAX_BYTES = 20 * 1024 * 1024;
const SCENARIO_COUNT = 8;

const MODULES: Record<string, Record<string, unknown>> = {
  parsers,
  matcher,
  safety,
  summary,
  answers,
};
const CORPORA = [...Object.keys(MODULES), 'scenarios'];

function exportedFunctions(mod: Record<string, unknown>): string[] {
  return Object.keys(mod)
    .filter((k) => typeof mod[k] === 'function')
    .sort();
}

function runSuite(rawDir: string): void {
  const require = createRequire(import.meta.url);
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const res = spawnSync(
    process.execPath,
    [vitest, 'run', '--config', join(here, 'vitest.config.ts')],
    { cwd: server, env: { ...process.env, PARITY_RAW_DIR: rawDir }, stdio: 'inherit' },
  );
  if (res.status !== 0) throw new Error(`parity: the vitest run failed (exit ${res.status})`);
}

interface Line {
  fn: string;
  args: string;
  line: string;
}

/** Splits a raw line into fn and the args JSON text, without re-serialising anything. */
function parseLine(line: string): Line {
  const parsed = JSON.parse(line) as { fn: unknown; args: unknown };
  if (typeof parsed.fn !== 'string' || !Array.isArray(parsed.args)) {
    throw new Error(`parity: malformed raw line: ${line.slice(0, 200)}`);
  }
  return { fn: parsed.fn, args: JSON.stringify(parsed.args), line };
}

function merge(rawDir: string, corpus: string): Line[] {
  const byKey = new Map<string, Line>();
  for (const file of readdirSync(rawDir).sort()) {
    if (!file.startsWith(`${corpus}.`)) continue;
    for (const raw of readFileSync(join(rawDir, file), 'utf8').split('\n')) {
      if (raw === '') continue;
      const l = parseLine(raw);
      const key = `${l.fn}\u0000${l.args}`;
      const seen = byKey.get(key);
      if (seen !== undefined && seen.line !== l.line) {
        throw new Error(
          `parity: ${l.fn} gave two results for the same args: ${l.args.slice(0, 300)}`,
        );
      }
      byKey.set(key, l);
    }
  }
  // plain code-unit comparison, never locale-dependent
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...byKey.values()].sort((a, b) => cmp(a.fn, b.fn) || cmp(a.args, b.args));
}

function main(): void {
  const rawDir = mkdtempSync(join(tmpdir(), 'medilens-parity-'));
  try {
    runSuite(rawDir);
    mkdirSync(outDir, { recursive: true });
    const problems: string[] = [];
    console.log('\nparity corpora:');
    for (const corpus of CORPORA) {
      const lines = merge(rawDir, corpus);
      const file = join(outDir, `${corpus}.jsonl`);
      writeFileSync(file, lines.map((l) => l.line).join('\n') + '\n');
      const bytes = statSync(file).size;
      console.log(`  ${corpus}.jsonl: ${lines.length} cases, ${bytes} bytes`);
      if (bytes > MAX_BYTES) problems.push(`${corpus}.jsonl is ${bytes} bytes, over 20 MB`);

      const counts = new Map<string, number>();
      for (const l of lines) counts.set(l.fn, (counts.get(l.fn) ?? 0) + 1);
      const mod = MODULES[corpus];
      const expected = mod === undefined ? [] : exportedFunctions(mod);
      for (const fn of [...new Set([...expected, ...counts.keys()])].sort()) {
        const n = counts.get(fn) ?? 0;
        console.log(`    ${fn}: ${n}`);
        if (n === 0) problems.push(`${corpus}.${fn} has no recorded case`);
      }
      if (corpus === 'scenarios' && lines.length !== SCENARIO_COUNT) {
        problems.push(`scenarios.jsonl has ${lines.length} cases, expected ${SCENARIO_COUNT}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`parity: recording incomplete:\n  ${problems.join('\n  ')}`);
    }
    console.log('parity: every exported domain function has at least one case.');
  } finally {
    rmSync(rawDir, { recursive: true, force: true });
  }
}

main();
