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
 * - `httpurl-idna.jsonl`: the same over IDNA_RANDOM seeded random hosts built
 *   from code points the IDNA processing treats differently (mapped, ignored,
 *   disallowed, marks, joiners, Bidi classes, composable pairs, A-labels,
 *   percent-encoded bytes), so the Go port is held to Node's parser (ada) on
 *   their combinations too (task G6 review round 1).
 * - `httpurl-codepoints.json` and `httpurl-codepoints.bin.gz`: the same over
 *   every Unicode scalar value c in each host pattern of the JSON ({c} is c,
 *   {ace} is "xn--" plus the Punycode of "a" + c, whose list the JSON pins by
 *   sha256); the gzip holds one little-endian uint16 per code point, bit k set
 *   when the schema accepts pattern k (surrogates are 0).
 * - `muse/*.json` and `phfda/*.json`: byte-for-byte copies of the synthetic
 *   recorded responses the Node provider tests use
 *   (apps/server/test/fixtures/{muse,phfda}), so the Go tests keep them after
 *   the Node server is removed (task G12).
 *
 * After the Node server is removed (task G12), re-recording needs
 * `git checkout node-fallback-v1` first (ruling R4).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encode as punycodeEncode } from 'node:punycode';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
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
  // UTS #46 ToASCII as the WHATWG host parser runs it (non-transitional,
  // CheckHyphens off, CheckBidi and CheckJoiners on, STD3 rules off); zod
  // then checks the A-label host (task G6 review round 1)
  'https://\u212Aelvin.example.com/x',
  'https://XN--abc.com/x',
  'https://XN--EXMPLE-CUA.COM/x',
  'https://www.XN--exmple-cua.com/x',
  'https://\u00E9xample.com/x',
  'https://e\u0301xample.com/x',
  'https://\uFF21bc.com/x',
  'https://example\uFF0Ecom/x',
  'https://example\uFF61com/x',
  'https://\uFF58\uFF4E--exmple-cua.com/x',
  'https://xn--exmple-cua\u3002com/x',
  'https://example.\uFF43\uFF4F\uFF4D/x',
  'https://\u0130stanbul.com/x',
  'https://\uFB01le.com/x',
  'https://\u2460.com/x',
  'https://\u2474x.com/x',
  'https://\u2488example.com/x',
  'https://exa\uFF0Dmple.com/x',
  // ignored code points
  'https://exa\u200Bmple.com/x',
  'https://exa\uFEFFmple.com/x',
  'https://exa\u034Fmple.com/x',
  'https://exa\uFE0Fmple.com/x',
  'https://\u00AD/x',
  'https://\u00AD.com/x',
  // deviations stay (non-transitional)
  'https://fa\u00DF.de/x',
  'https://\u03B2\u03CC\u03BB\u03BF\u03C2.com/x',
  // disallowed, or mapped to a forbidden domain code point
  'https://exa\uFFFDmple.com/x',
  'https://exa\uE000mple.com/x',
  'https://exa\u0080mple.com/x',
  'https://exa\u2028mple.com/x',
  'https://exa\u0378mple.com/x',
  'https://exa\u2024mple.com/x',
  'https://exa\uFE52mple.com/x',
  'https://exa\uFF0Fmple.com/x',
  'https://exa\uFF1Ample.com/x',
  'https://user\uFF20example.com/x',
  'https://\u2100.com/x',
  'https://\u0301example.com/x',
  // CheckJoiners (ContextJ)
  'https://a\u200Cb.com/x',
  'https://\u0915\u094D\u200C\u0937.com/x',
  'https://\u0915\u094D\u200D\u0937.com/x',
  'https://\u0628\u200C\u0628.com/x',
  // CheckBidi (RFC 5893)
  'https://\u05D0\u05D1.com/x',
  'https://\u05D0a.com/x',
  'https://a\u05D0.com/x',
  'https://1\u05D0.com/x',
  'https://\u05D01.com/x',
  'https://\u0627\u0661.com/x',
  'https://\u05D0\u06611.com/x',
  'https://1a.\u05D0.com/x',
  'https://a1.\u05D0.com/x',
  // A-labels: punycode that fails, decodes to ASCII only, to a non-NFC, mapped,
  // disallowed or joiner label, to a leading mark, to an xn-- label, or that is valid
  'https://xn--a.com/x',
  'https://xn--abc-.com/x',
  'https://xn--a_b.com/x',
  'https://xn--example-tge.com/x',
  'https://xn--exmple-xna.com/x',
  'https://xn--ab-gg4n.com/x',
  'https://xn--ab-j1t.com/x',
  'https://xn--abc-jdc.com/x',
  'https://xn--a-zhc.com/x',
  'https://xn--xn---ooa.com/x',
  'https://xn--fa-hia.de/x',
  'https://xn--nxasmm1c.com/x',
  'https://xn--ls8h.la/x',
  'https://\u{1F4A9}.la/x',
  'https://example.\u0441om/x',
  'https://\u0441\u0430\u0439\u0442.xn--p1ai/x',
  // percent-encoded non-ASCII: UTF-8 decoded without BOM stripping, a bad
  // sequence becomes U+FFFD
  'https://%C3%A9xample.com/x',
  'https://ex%E2%80%8Bample.com/x',
  'https://%EF%BB%BFexample.com/x',
  'https://example%E3%80%82com/x',
  'https://exa%C2mple.com/x',
  'https://exa%ED%A0%80mple.com/x',
  // A-label lengths: the label limit is 63, the host limit 253
  `https://${'a'.repeat(55)}\u00E4.com/x`,
  `https://${'a'.repeat(56)}\u00E4.com/x`,
  `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(49)}\u00E4.com/x`,
  `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(50)}\u00E4.com/x`,
  // the rest of the URL around a non-ASCII host
  'https://user@ex\u00E4mple.com:8080/x',
  'https://ex\u00E4mple.com:99999/x',
  'https://ex\u00E4mple.com\\x',
  'https://ex\u00E4m\nple.com/x',
  // where Node's parser (ada 4.0.0) departs from the letter of UTS #46:
  // its NFC quick check passes U+00E2 U+0323 and U+AC00 U+11A8 as they are,
  // its normalization tables stop at Unicode 15.1 (U+1611E U+1611E stays),
  // its Bidi and combining-mark tables at Unicode 13 (U+061D, U+0C3C, U+1734),
  // its ContextJ check returns at the first joiner, and an A-label is only
  // checked in a non-ASCII host
  'https://\u00E4.xn--2ca86i.com/x',
  'https://\u00E4.xn--rud7310f.com/x',
  'https://\u00E4.xn--fy7ea.com/x',
  'https://\u00E4.xn--iy7e.com/x',
  'https://\u05D0\u061D\u05D0.com/x',
  'https://\u061Da.com/x',
  'https://\u0C3Ca.com/x',
  'https://\u05D0\u1734.com/x',
  'https://\u0915\u094D\u200C\u200D.com/x',
  'https://\u0628a\u200Cb\u0628.com/x',
  'https://\u05D0\u094D\u200Ca.com/x',
  'https://\u00E4.xn--ab-j1t.com/x',
  // ada refuses a percent-decoded host over 16384 bytes before mapping it,
  // even one whose ignored code points would map away: 16384 and 16385 bytes
  `https://${'\u00AD'.repeat(8189)}ab.com/x`,
  `https://${'\u00AD'.repeat(8189)}abc.com/x`,
  `https://${'%C2%AD'.repeat(8189)}ab.com/x`,
  `https://${'%C2%AD'.repeat(8189)}abc.com/x`,
  // paths, queries and fragments never fail
  'https://example.com/path?q=1#frag',
  'https://example.com?x',
  'https://example.com#x',
  'https://example.com/\u00E9',
  'https://example.com/%00',
  'https://example.com/%zz',
  'https://example.com/<>"',
];

function httpUrlLine(url: string): string {
  const parsed = AdvisorySchema.safeParse({ title: 't', url });
  const result = parsed.success ? { success: true, url: parsed.data.url } : { success: false };
  return JSON.stringify({ fn: 'httpUrl', args: [url], result });
}

function httpUrlLines(): string[] {
  return URL_PROBES.map(httpUrlLine);
}

/* ------------------------------------------- IDNA hosts (G6 review round 1) */

const IDNA_RANDOM = 2000;
const IDNA_SEED = 20261028;

/** mulberry32: a small seeded PRNG, so a re-recording gives the same file. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cps = (...xs: number[]): string[] => xs.map((x) => String.fromCodePoint(x));

/* Code points the IDNA processing treats differently, by kind. */
const IDNA_POOLS: string[][] = [
  [...'abcxyzAZ09-_'],
  // letters: plain, mapped, deviations
  cps(
    0xe4,
    0xe9,
    0xdf,
    0xc4,
    0xc9,
    0x3b2,
    0x441,
    0x4e2d,
    0x1f4a9,
    0x130,
    0x212a,
    0xfb01,
    0x2460,
    0x1e9e,
    0x3a3,
    0x3c2,
  ),
  // combining marks, viramas, marks ada's tables do not know or class differently
  cps(
    0x301,
    0x308,
    0x323,
    0x302,
    0x309,
    0x327,
    0x304,
    0x94d,
    0x5b0,
    0x64b,
    0x1ae0,
    0x1734,
    0x1171e,
    0xc3c,
  ),
  // R, AL, AN and EN in Arabic and Hebrew, and RTL letters newer than ada's Bidi table
  cps(
    0x5d0,
    0x5d1,
    0x627,
    0x628,
    0x661,
    0x660,
    0x6f1,
    0x66b,
    0x66c,
    0x60c,
    0x61d,
    0x870,
    0x8b5,
    0x10d50,
    0x10d40,
  ),
  // joiners and the joining types ada lists
  cps(0x200c, 0x200d, 0x915, 0x937, 0xa872, 0x1820, 0x622),
  // ignored
  cps(0xad, 0x200b, 0xfeff, 0x34f, 0xfe0f, 0xe0100),
  // mapped to ASCII, dots
  cps(0xff21, 0xff41, 0xff0d, 0x3002, 0xff0e, 0xff61, 0xff10),
  // disallowed, or mapped to a forbidden domain code point
  cps(
    0xfffd,
    0xe000,
    0x80,
    0x2028,
    0x378,
    0xffff,
    0xff0f,
    0xff1a,
    0xff20,
    0x2100,
    0x2474,
    0x2488,
    0x20c0,
    0x2427,
  ),
  // Hangul jamo and syllables, composable pairs, Unicode 16 composites
  cps(
    0x1100,
    0x1161,
    0x11a8,
    0xac00,
    0xac01,
    0xe2,
    0x1ea1,
    0x1ea3,
    0x1611e,
    0x16121,
    0x105d2,
    0x113c2,
    0x16d67,
  ),
  [
    'xn--',
    'XN--',
    'ｘｎ--',
    '.',
    '。',
    '%C3%A4',
    '%E3%80%82',
    '%C2',
    '%41',
    '%2E',
    '%zz',
    '%CC%81',
  ],
];

function idnaHosts(): string[] {
  const rand = prng(IDNA_SEED);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)] as T;
  const plainLabel = (): string => {
    let s = '';
    for (let n = 1 + Math.floor(rand() * 6); n > 0; n--) s += pick(pick(IDNA_POOLS));
    return s;
  };
  const aceLabel = (): string => {
    if (rand() < 0.15) {
      let s = 'xn--';
      for (let n = 1 + Math.floor(rand() * 8); n > 0; n--)
        s += pick([...'abcdefghijklmnopqrstuvwxyz0123456789-']);
      return s;
    }
    let u = '';
    for (let n = 1 + Math.floor(rand() * 5); n > 0; n--) u += pick(pick(IDNA_POOLS.slice(0, 9)));
    return 'xn--' + punycodeEncode(u.replace(/[.。．｡%]/g, 'q'));
  };
  const hosts: string[] = [];
  for (let i = 0; i < IDNA_RANDOM; i++) {
    const labels: string[] = [];
    for (let n = 1 + Math.floor(rand() * 3); n > 0; n--)
      labels.push(rand() < 0.3 ? aceLabel() : plainLabel());
    if (rand() < 0.5) labels.push(rand() < 0.5 ? 'ä' : 'bé');
    labels.push(rand() < 0.8 ? 'com' : plainLabel());
    hosts.push(`https://${labels.join(rand() < 0.9 ? '.' : '。')}/x`);
  }
  return hosts;
}

/* Host patterns over every code point: {c} is the code point, {ace} the
   A-label of "a" + c. They reach the mapping, the leading-mark test, the
   Bidi classes (R/AL, AN, EN, the RTL-allowed set, NSM at the end), the
   joining types and viramas, and A-label validation. */
const CODE_POINT_PATTERNS = [
  'https://{c}a.com/x',
  'https://a{c}a.com/x',
  'https://א{c}א.com/x',
  'https://א{c}.com/x',
  'https://{c}‌ب.com/x',
  'https://ب‌{c}.com/x',
  'https://ä.{ace}.com/x',
  'https://{c}{c}.com/x',
  'https://א{c}1א.com/x',
  'https://א{c}١א.com/x',
  'https://{c}א.com/x',
];

function codePointRecord(): { meta: unknown; bits: Buffer } {
  const url = AdvisorySchema.shape.url;
  const bits = Buffer.alloc(0x110000 * 2);
  const aces = createHash('sha256');
  const accepted = CODE_POINT_PATTERNS.map(() => 0);
  let codePoints = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    codePoints++;
    const c = String.fromCodePoint(cp);
    const ace = 'xn--' + punycodeEncode('a' + c);
    aces.update(ace + '\n');
    let b = 0;
    CODE_POINT_PATTERNS.forEach((p, k) => {
      if (url.safeParse(p.replaceAll('{c}', c).replaceAll('{ace}', ace)).success) {
        b |= 1 << k;
        accepted[k] = (accepted[k] ?? 0) + 1;
      }
    });
    bits.writeUInt16LE(b, cp * 2);
  }
  const meta = {
    patterns: CODE_POINT_PATTERNS,
    aceSha256: aces.digest('hex'),
    codePoints,
    accepted,
    node: process.version,
    ada: process.versions.ada,
  };
  return { meta, bits };
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
  const idna = idnaHosts().map(httpUrlLine);
  writeFileSync(path.join(OUT, 'httpurl-idna.jsonl'), idna.join('\n') + '\n');
  const { meta, bits } = codePointRecord();
  writeFileSync(path.join(OUT, 'httpurl-codepoints.json'), JSON.stringify(meta, null, 2) + '\n');
  // mtime 0 in the gzip header, so a re-recording is byte-identical
  writeFileSync(path.join(OUT, 'httpurl-codepoints.bin.gz'), gzipSync(bits, { level: 9 }));
  const muse = copyFixtures('muse');
  const phfda = copyFixtures('phfda');
  console.log(
    `providers: ${requests.length} muse requests, ${lines.length} httpUrl probes, ${idna.length} IDNA hosts, ` +
      `${CODE_POINT_PATTERNS.length} patterns over every code point`,
  );
  console.log(`providers: copied ${muse.length} muse and ${phfda.length} phfda fixtures`);
}

await main();
