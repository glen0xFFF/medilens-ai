/**
 * Records the provider parity set for the Go providers port (task G6): what
 * the Node build's own provider code sends and accepts.
 *
 *   npx tsx scripts/parity/record-providers.ts
 *
 * Writes fixtures/parity/providers/:
 *
 * - `muse-requests.json`: the exact request bodies the Node Muse Spark
 *   adapters (apps/server/src/providers/museSpark.ts) hand to the chat
 *   completions client, captured with a fake client: the label reader with
 *   1, 2 and 3 images, and the explainer for one printed phrase. They pin the
 *   prompts, the image parts and the strict JSON Schemas. No network.
 * - `httpurl.jsonl`: `AdvisorySchema` (packages/contracts, `url: z.httpUrl()`)
 *   over a probe list of URL strings, one `{fn, args, result}` line each:
 *   `result` is `{success, url}` with the URL the schema outputs (it trims and
 *   drops ASCII tab and newline), or `{success: false}`.
 * - `muse/*.json` and `phfda/*.json`: byte-for-byte copies of the synthetic
 *   recorded responses the Node provider tests use
 *   (apps/server/test/fixtures/{muse,phfda}), so the Go tests keep them after
 *   the Node server is removed (task G12).
 *
 * After the Node server is removed (task G12), re-recording needs
 * `git checkout node-fallback-v1` first (ruling R4).
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdvisorySchema, type ExtractedLabel, type FieldKey } from '@medilens/contracts';
import {
  createMuseSparkAnswerer,
  createMuseSparkLabelReader,
  type ChatClient,
} from '../../apps/server/src/providers/museSpark';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'fixtures/parity/providers');
const NODE_FIXTURES = path.join(ROOT, 'apps/server/test/fixtures');

/* The same bytes as apps/server/test/providers/museSpark.test.ts. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const JPEG2 = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x01, 0x02, 0x03]);

function lf(key: FieldKey, value: string | null, legibility: 'clear' | 'partial' = 'clear') {
  return { key, value, legibility, evidenceText: value, imageIndex: 0, notes: null };
}

/* The answerer test label (museSpark.test.ts LABEL), synthetic DEMO DATA. */
const LABEL: ExtractedLabel = {
  imageKind: 'label',
  fields: [
    lf('brandName', 'Paracelin 500'),
    lf('genericNames', 'Paracetamol'),
    lf('strength', '500 mg', 'partial'),
    lf('directions', 'Adults: 1 tablet every 4 to 6 hours as needed.'),
    lf('warnings', 'Do not exceed the stated dose.  Keep out of reach of children.'),
    lf('storage', 'Store in a cool dry place.'),
    lf('registrationNumber', 'DR-XY12345'),
    lf('rxOrOtc', null),
  ],
  rawText: 'DEMO DATA Paracelin 500 Paracetamol 500 mg. Shake well before use.',
  warnings: [],
};

function json(name: string): unknown {
  return JSON.parse(readFileSync(path.join(NODE_FIXTURES, 'muse', `${name}.json`), 'utf8'));
}

async function museRequests(): Promise<{ case: string; body: unknown }[]> {
  const out: { case: string; body: unknown }[] = [];
  const capture = (name: string, reply: unknown): ChatClient =>
    ({
      create: (body: unknown) => {
        out.push({ case: name, body });
        return Promise.resolve(reply);
      },
    }) as unknown as ChatClient;

  const labelOk = json('label-ok');
  await createMuseSparkLabelReader(capture('read-1-image', labelOk)).read([JPEG], {});
  await createMuseSparkLabelReader(capture('read-2-images', labelOk)).read([JPEG, JPEG2], {});
  await createMuseSparkLabelReader(capture('read-3-images', labelOk)).read([JPEG, JPEG2, JPEG], {});
  await createMuseSparkAnswerer(capture('explain-storage', json('answer-explain-ok'))).answer(
    {
      label: LABEL,
      match: {
        status: 'not_attempted',
        matched: [],
        conflicting: [],
        missing: [],
        candidates: [],
        advisories: [],
        limitations: [],
      },
      question: 'what does   STORE IN A COOL DRY PLACE mean in simpler words?',
      intent: 'explain_text',
    },
    {},
  );
  return out;
}

const LONG_LABEL = 'a'.repeat(63);
const HOST_253 = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;

/** Probe URLs for z.httpUrl(): the shapes the WHATWG parser and the domain check disagree on. */
const URL_PROBES: string[] = [
  'https://www.fda.gov.ph/fda-advisory-no-2099-0001-demo/',
  'https://www.fda.gov.ph/ok-demo',
  'https://github.com/medilens-ai',
  'https://github.com/example/medilens-ai',
  'http://a.bc',
  'HTTPS://WWW.FDA.GOV.PH/X',
  'Http://Example.COM',
  'https://EXAMPLE.com/Path',
  // the Node tests' rejected links
  'https:/www.fda.gov.ph/x',
  'https://localhost/x',
  'http://10.0.0.1/a',
  'javascript:alert(1)',
  'not a url',
  // schemes and the :// guard
  'ftp://example.com/x',
  'https:example.com',
  'https:\\\\example.com',
  'https:/\\example.com',
  'mailto:a@example.com',
  'data:text/plain,https://example.com',
  ' https://example.com',
  // whitespace the schema trims, and tab/newline it drops
  '  https://example.com/a  ',
  '\u00A0https://example.com/a\u3000',
  '\uFEFFhttps://example.com/a',
  'https://example.com/a\n',
  'https://exa\nmple.com/a',
  'https://exa\tmple.com/a',
  'https://example.com/a\tb\rc',
  'https://example.com/\u0001',
  'https://example.com\u0001',
  'https://example.com\u0000',
  'https://example.com/a b',
  // slashes and backslashes after the scheme
  'https:////example.com/x',
  'https://\\example.com/x',
  'https://\\\\example.com/x',
  'https://example.com\\path',
  'https://example.com\\@evil.com/',
  // credentials
  'https://user:pass@example.com/',
  'https://@example.com/',
  'https://user@/x',
  'https://a@b@example.com/',
  'https://example.com@evil.com/',
  'https://example.com:443@evil.com/',
  'https://evil.com#@example.com',
  'https://evil.com?@example.com',
  // ports
  'https://example.com:8080/x',
  'https://example.com:/x',
  'https://example.com:0/x',
  'https://example.com:65535/x',
  'https://example.com:65536/x',
  'https://example.com:99999/x',
  'https://example.com:80a/x',
  'https://example.com:-1/x',
  'https://example.com: 80/x',
  'https://example.com:0080/x',
  'https://example.com:\uFF18\uFF10/x',
  'https://example.com::80/x',
  // empty and odd hosts
  'https://',
  'https:///',
  'https://?x',
  'https://#x',
  'https://:80/x',
  'https://[::1]/x',
  'https://[::1/x',
  'https://example.com]/x',
  'https://1.2.3.4/x',
  'https://1.2.3.4.com/x',
  'https://0x7f.1/x',
  'https://example.123/x',
  'https://example.0x1/x',
  'https://example.c/x',
  'https://example.c0m/x',
  'https://example.com./x',
  'https://example..com/x',
  'https://.example.com/x',
  'https://-example.com/x',
  'https://example-.com/x',
  'https://ex--ample.com/x',
  'https://exa_mple.com/x',
  'https://*.example.com/x',
  'https://exa mple.com/x',
  'https://exa%20mple.com/x',
  'https://exa<mple.com/x',
  'https://exa^mple.com/x',
  'https://exa|mple.com/x',
  'https://exa{mple.com/x',
  'https://exa"mple.com/x',
  "https://exa'mple.com/x",
  'https://exa`mple.com/x',
  'https://exa~mple.com/x',
  'https://exa!mple.com/x',
  'https://exa$mple.com/x',
  'https://exa&mple.com/x',
  'https://exa(mple.com/x',
  'https://exa;mple.com/x',
  'https://exa=mple.com/x',
  'https://exa,mple.com/x',
  'https://exa+mple.com/x',
  'https://exa\u007fmple.com/x',
  // percent-encoded hosts
  'https://ex%61mple.com/x',
  'https://%65xample.com/x',
  'https://ex%2Eample.com/x',
  'https://EX%41MPLE.COM/x',
  'https://example.com%2F/x',
  'https://exam%zzple.com/x',
  'https://exam%2ple.com/x',
  'https://%/x',
  'https://exa%00mple.com/x',
  'https://exa%C3%A4mple.com/x',
  'https://exa%FFmple.com/x',
  // lengths
  `https://${LONG_LABEL}.com/x`,
  `https://${LONG_LABEL}a.com/x`,
  `https://example.${'a'.repeat(63)}/x`,
  `https://example.${'a'.repeat(64)}/x`,
  `https://${HOST_253}/x`,
  `https://${HOST_253}a/x`,
  // non-ASCII hosts (IDNA)
  'https://ex\u00E4mple.com/x',
  'https://EX\u00C4MPLE.com/x',
  'https://xn--exmple-cua.com/x',
  'https://xn--abc.com/x',
  'https://xn--.com/x',
  'https://ex\u00ADmple.com/x',
  'https://\uFF45xample.com/x',
  'https://example\u3002com/x',
  'https://exa\u200Dmple.com/x',
  'https://\u0645\u062B\u0627\u0644.com/x',
  // paths, queries and fragments never fail
  'https://example.com/path?q=1#frag',
  'https://example.com?x',
  'https://example.com#x',
  'https://example.com/\u00E9',
  'https://example.com/%00',
  'https://example.com/%zz',
  'https://example.com/<>"',
];

function httpUrlLines(): string[] {
  return URL_PROBES.map((url) => {
    const parsed = AdvisorySchema.safeParse({ title: 't', url });
    const result = parsed.success ? { success: true, url: parsed.data.url } : { success: false };
    return JSON.stringify({ fn: 'httpUrl', args: [url], result });
  });
}

function copyFixtures(dir: string): string[] {
  const from = path.join(NODE_FIXTURES, dir);
  const to = path.join(OUT, dir);
  mkdirSync(to, { recursive: true });
  const files = readdirSync(from)
    .filter((f) => f.endsWith('.json'))
    .sort();
  for (const f of files) copyFileSync(path.join(from, f), path.join(to, f));
  return files;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const requests = await museRequests();
  writeFileSync(path.join(OUT, 'muse-requests.json'), JSON.stringify(requests, null, 2) + '\n');
  const lines = httpUrlLines();
  writeFileSync(path.join(OUT, 'httpurl.jsonl'), lines.join('\n') + '\n');
  const muse = copyFixtures('muse');
  const phfda = copyFixtures('phfda');
  console.log(`providers: ${requests.length} muse requests, ${lines.length} httpUrl probes`);
  console.log(`providers: copied ${muse.length} muse and ${phfda.length} phfda fixtures`);
}

await main();
