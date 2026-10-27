/**
 * Label accuracy eval (spec §5.1). Runs the LIVE Muse Spark reader over every
 * pack in eval/packs/<id>/ (truth.json + its images), prints a per-field
 * table and every confidently-wrong case, and writes aggregate counts only to
 * docs/eval-results.md. Photos and read text never leave this machine.
 *
 *   MODEL_API_KEY=... npm run eval:labels -w @medilens/server
 *
 * Exit codes: 0 done (or no packs), 1 setup error, 2 the strength/expiry bar was missed.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config';
import {
  GroundTruthSchema,
  meetsBar,
  renderResultsMarkdown,
  scoreLabel,
  summarize,
  type FieldScore,
  type GroundTruth,
} from '../src/eval/score';
import { normalizeImage, validateImage } from '../src/imaging/validate';
import { createSpendMeter } from '../src/pipeline/budget';
import { createMetaClient, createMuseSparkLabelReader } from '../src/providers/museSpark';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACKS_DIR = join(ROOT, 'eval', 'packs');
const RESULTS_FILE = join(ROOT, 'docs', 'eval-results.md');

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function packDirs(): string[] {
  if (!existsSync(PACKS_DIR)) return [];
  return readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(PACKS_DIR, d.name, 'truth.json')))
    .map((d) => d.name)
    .sort();
}

function loadTruth(dir: string): GroundTruth | string {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(PACKS_DIR, dir, 'truth.json'), 'utf8'));
  } catch {
    return 'truth.json is not valid JSON';
  }
  const parsed = GroundTruthSchema.safeParse(json);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  }
  // Image names must be plain file names inside the pack folder.
  if (parsed.data.images.some((name) => basename(name) !== name)) {
    return 'images must be file names inside the pack folder';
  }
  return parsed.data;
}

/** Same in-memory preparation as the live pipeline: validate, then normalise. */
async function loadImages(dir: string, names: string[]): Promise<Buffer[] | string> {
  const out: Buffer[] = [];
  for (const name of names) {
    const path = join(PACKS_DIR, dir, name);
    if (!existsSync(path)) return `missing image ${name}`;
    const buf = readFileSync(path);
    const v = await validateImage(buf);
    if (!v.ok) return `${name}: ${v.code}`;
    out.push(await normalizeImage(buf));
  }
  return out;
}

async function main(): Promise<void> {
  const dirs = packDirs();
  if (dirs.length === 0) {
    console.log('No packs found');
    return;
  }

  const key = process.env.MODEL_API_KEY?.trim();
  if (key === undefined || key === '') {
    fail(
      'MODEL_API_KEY is not set. The accuracy eval runs the live Muse Spark reader and needs it.',
    );
  }
  let capUsd: number;
  try {
    capUsd = loadConfig({ DAILY_SPEND_CAP_USD: process.env.DAILY_SPEND_CAP_USD }).dailySpendCapUsd;
  } catch (err) {
    fail(err instanceof Error ? err.message : 'Invalid DAILY_SPEND_CAP_USD.');
  }

  const meter = createSpendMeter(capUsd, Date.now);
  const reader = createMuseSparkLabelReader(createMetaClient(key), {
    onUsage: (usage) => meter.record(usage),
  });

  const scored: FieldScore[][] = [];
  const confidentlyWrong: { packId: string; field: string; value: string | null }[] = [];
  const skipped: { dir: string; reason: string }[] = [];

  for (const dir of dirs) {
    if (meter.exhausted()) {
      console.error(`Daily spend cap of $${capUsd} reached; stopping before pack ${dir}.`);
      break;
    }
    const truth = loadTruth(dir);
    if (typeof truth === 'string') {
      skipped.push({ dir, reason: truth });
      continue;
    }
    const images = await loadImages(dir, truth.images);
    if (typeof images === 'string') {
      skipped.push({ dir, reason: images });
      continue;
    }
    const read = await reader.read(images, {});
    if (!read.ok) {
      skipped.push({ dir, reason: `${read.code} (${read.detail})` });
      continue;
    }
    const scores = scoreLabel(truth, read.label);
    scored.push(scores);
    for (const s of scores.filter((x) => x.confidentlyWrong)) {
      const value = read.label.fields.find((f) => f.key === s.field)?.value ?? null;
      confidentlyWrong.push({ packId: truth.packId, field: s.field, value });
    }
    console.log(`Scored ${truth.packId}`);
  }

  for (const s of skipped) console.error(`Skipped ${s.dir}: ${s.reason}`);
  if (scored.length === 0) fail('No pack could be scored; docs/eval-results.md was not written.');

  const summary = summarize(scored);
  console.log(`\nPacks scored: ${summary.packs}   Spent: $${meter.spentUsd().toFixed(4)}\n`);
  console.table(
    summary.fields.map((f) => ({
      field: f.field,
      correct: `${f.correct}/${f.total}`,
      unreadable: f.unreadable,
      confidentlyWrong: f.confidentlyWrong,
    })),
  );

  if (confidentlyWrong.length === 0) {
    console.log('No confidently-wrong fields.');
  } else {
    console.log('Confidently wrong (value wrong while legibility was clear):');
    for (const c of confidentlyWrong) {
      console.log(
        `  ${c.packId}  ${c.field}  read: ${c.value === null ? '(null)' : JSON.stringify(c.value)}`,
      );
    }
  }

  writeFileSync(
    RESULTS_FILE,
    renderResultsMarkdown(summary, new Date().toISOString().slice(0, 10)),
  );
  console.log(`\nWrote aggregate counts to ${RESULTS_FILE}`);
  const bar = meetsBar(summary);
  console.log(`Bar (zero confidently-wrong strengths or expiry dates): ${bar ? 'MET' : 'NOT MET'}`);
  if (!bar) process.exitCode = 2;
}

main().catch((err: unknown) => {
  // Never print the error object itself: a client error could echo request headers.
  fail(`Eval failed: ${err instanceof Error ? err.name : 'unknown error'}`);
});
