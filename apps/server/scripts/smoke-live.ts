/**
 * Live smoke test (spec §9). One Muse Spark label read on a photo you provide
 * and one PH FDA registry lookup, both through the production adapters.
 * Prints the serving model id, finish reason, token usage (including
 * reasoning_tokens when the API reports them), HTTP status and response key
 * names. It never prints read text, raw text, evidence or registry values.
 * Run manually with a key; never in CI.
 *
 *   MODEL_API_KEY=... npx tsx apps/server/scripts/smoke-live.ts <image> [fda-search-term]
 *
 * The FDA term defaults to "biogesic". Exit codes: 0 done, 1 setup or request
 * error, 3 aborted because a contributor model served the request.
 */
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, userAgent } from '../src/config';
import {
  recordingClient,
  recordingFetch,
  renderSmokeReport,
  type CompletionRecord,
  type FetchRecord,
} from '../src/eval/smoke';
import { normalizeImage, validateImage } from '../src/imaging/validate';
import { createMetaClient, createMuseSparkLabelReader } from '../src/providers/museSpark';
import { createPhFdaProvider } from '../src/providers/phFda';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const [imagePath, term = 'biogesic'] = process.argv.slice(2);
  if (imagePath === undefined) {
    fail('Usage: npx tsx apps/server/scripts/smoke-live.ts <image> [fda-search-term]');
  }
  const key = process.env.MODEL_API_KEY?.trim();
  if (key === undefined || key === '') fail('MODEL_API_KEY is not set. The live smoke test needs it.');
  if (!existsSync(imagePath)) fail('Image file not found.');

  const raw = readFileSync(imagePath);
  const valid = await validateImage(raw);
  if (!valid.ok) fail(`Image rejected: ${valid.code}`);
  const image = await normalizeImage(raw);

  const completions: CompletionRecord[] = [];
  const reader = createMuseSparkLabelReader(recordingClient(createMetaClient(key), completions));
  const read = await reader.read([image], {});

  const first = renderSmokeReport({ completions, read, fetches: [], fda: undefined });
  if (first.aborted) {
    for (const line of first.lines) console.log(line);
    process.exitCode = 3;
    return;
  }

  const fetches: FetchRecord[] = [];
  let ua: string;
  try {
    ua = userAgent(loadConfig({ PUBLIC_REPO_URL: process.env.PUBLIC_REPO_URL }));
  } catch (err) {
    fail(err instanceof Error ? err.message : 'Invalid PUBLIC_REPO_URL.');
  }
  const fda = await createPhFdaProvider({
    fetch: recordingFetch((input, init) => fetch(input, init), fetches),
    now: Date.now,
    userAgent: ua,
  }).search({ name: term }, {});

  const report = renderSmokeReport({ completions, read, fetches, fda });
  for (const line of report.lines) console.log(line);
  if (!read.ok || fda.kind !== 'ok') process.exitCode = 1;
}

main().catch((err: unknown) => {
  // Never print the error object itself: a client error could echo request headers.
  fail(`Smoke test failed: ${err instanceof Error ? err.name : 'unknown error'}`);
});
