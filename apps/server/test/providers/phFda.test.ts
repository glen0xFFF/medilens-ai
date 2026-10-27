import { readFileSync } from 'node:fs';
import { ReferenceRecordSchema } from '@medilens/contracts';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TtlCache } from '../../src/providers/cache';
import { createPhFdaProvider } from '../../src/providers/phFda';

/* Synthetic PH FDA search response (DEMO DATA, fictional products). No network. */
const FIXTURE = readFileSync(
  new URL('../fixtures/phfda/search-paracelin.json', import.meta.url),
  'utf8',
);
const UA = 'MediLensAI/0.1 (+https://github.com/medilens-ai)';
const T0 = Date.parse('2026-10-27T08:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

type Reply = { status?: number; body: string } | 'hang' | Error;

function fakeFetch(...replies: Reply[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const next = replies.length > 1 ? replies.shift() : replies[0];
    if (next === undefined) return Promise.reject(new Error('fake fetch: no reply queued'));
    if (next === 'hang') return new Promise<Response>(() => undefined);
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(new Response(next.body, { status: next.status ?? 200 }));
  };
  return { fetch: fn as typeof fetch, calls };
}

function setup(...replies: Reply[]) {
  const clock = { t: T0 };
  const f = fakeFetch(...replies);
  const provider = createPhFdaProvider({ fetch: f.fetch, now: () => clock.t, userAgent: UA });
  return { provider, calls: f.calls, clock };
}

const ok = (body: string = FIXTURE): Reply => ({ body });
const EMPTY = JSON.stringify({ cdrr: [], fdawebsite: [] });

afterEach(() => {
  vi.useRealTimers();
});

describe('TtlCache', () => {
  test('returns values until the TTL elapses', () => {
    let t = 0;
    const c = new TtlCache<string, number>(1000, () => t);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
    t = 999;
    expect(c.get('a')).toBe(1);
    t = 1000;
    expect(c.get('a')).toBeUndefined();
    expect(c.get('missing')).toBeUndefined();
  });
});

describe('createPhFdaProvider', () => {
  test('maps the fixture cdrr rows to ReferenceRecords and drops invalid rows', async () => {
    const { provider, calls } = setup(ok());
    const r = await provider.search({ name: 'Paracelin' }, {});
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    // Third row has no registration number and is dropped.
    expect(r.records).toHaveLength(2);
    for (const rec of r.records) expect(ReferenceRecordSchema.safeParse(rec).success).toBe(true);
    expect(r.records[0]).toEqual({
      provider: 'ph-fda',
      sourceUrl: 'https://verification.fda.gov.ph/?search=paracelin',
      registrationNumber: 'DR-XY99001',
      brandName: 'Paracelin',
      genericName: 'Paracetamol',
      strengthForm: '500 mg Tablet',
      manufacturer: 'Demo Fictional Pharma, Inc.',
      classification: 'Over-the-Counter (OTC) Drug',
      registrationExpiry: '01 January 2030',
      checkedAt: '2026-10-27T08:00:00.000Z',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://verification.fda.gov.ph/api/search?q=paracelin');
  });

  test('advisories: brand in title (case-insensitive), http(s) url only', async () => {
    const { provider } = setup(ok());
    const r = await provider.search({ name: 'PARACELIN' }, {});
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.advisories).toEqual([
      {
        title:
          "FDA Advisory No.2099-0001 || Public Health Warning Against the Purchase and Use of the Counterfeit Drug Product 'Paracetamol (PARACELIN) 500 mg Tablet'",
        url: 'https://www.fda.gov.ph/fda-advisory-no-2099-0001-demo/',
      },
    ]);
  });

  test('sends the honest User-Agent and accepts JSON', async () => {
    const { provider, calls } = setup(ok());
    await provider.search({ name: 'Paracelin' }, {});
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('user-agent')).toBe(UA);
    expect(calls[0]?.init?.method ?? 'GET').toBe('GET');
  });

  test('queries the registration number first; a hit keeps its records and spends fetch 2 on advisories', async () => {
    const { provider, calls } = setup(ok());
    const r = await provider.search({ registrationNumber: 'dr-xy 99001', name: 'Paracelin' }, {});
    expect(r.kind).toBe('ok');
    expect(calls.map((c) => c.url)).toEqual([
      'https://verification.fda.gov.ph/api/search?q=DR-XY99001',
      'https://verification.fda.gov.ph/api/search?q=paracelin',
    ]);
    if (r.kind === 'ok') {
      expect(r.records[0]?.sourceUrl).toBe('https://verification.fda.gov.ph/?search=DR-XY99001');
      // The same advisory in both responses is reported once.
      expect(r.advisories).toHaveLength(1);
      expect(r.advisoriesUnchecked).toBeUndefined();
    }
  });

  test('reg hit with fdawebsite: [] still surfaces the counterfeit advisory from the name lookup', async () => {
    const regOnly = JSON.stringify({ ...JSON.parse(FIXTURE), fdawebsite: [] });
    const nameBody = JSON.stringify({ ...JSON.parse(FIXTURE), cdrr: [] });
    const { provider, calls } = setup(ok(regOnly), ok(nameBody));
    const r = await provider.search({ registrationNumber: 'DR-XY99001', name: 'Paracelin' }, {});
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe('https://verification.fda.gov.ph/api/search?q=paracelin');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    // Records come from the registration hit only.
    expect(r.records).toHaveLength(2);
    expect(r.records.every((x) => x.sourceUrl.endsWith('?search=DR-XY99001'))).toBe(true);
    expect(r.advisories).toHaveLength(1);
    expect(r.advisories[0]?.title).toMatch(/Counterfeit/);
  });

  test('reg hit on a registration-only query uses the record brand for the advisory fetch', async () => {
    const regOnly = JSON.stringify({ ...JSON.parse(FIXTURE), fdawebsite: [] });
    const { provider, calls } = setup(ok(regOnly), ok());
    const r = await provider.search({ registrationNumber: 'DR-XY99001' }, {});
    expect(calls.map((c) => c.url)).toEqual([
      'https://verification.fda.gov.ph/api/search?q=DR-XY99001',
      'https://verification.fda.gov.ph/api/search?q=paracelin',
    ]);
    expect(r.kind === 'ok' && r.advisories.length).toBe(1);
  });

  test('reg hit but the advisory fetch fails → ok records, flagged advisoriesUnchecked', async () => {
    const regOnly = JSON.stringify({ ...JSON.parse(FIXTURE), fdawebsite: [] });
    const { provider, calls } = setup(ok(regOnly), { status: 503, body: 'down' });
    const r = await provider.search({ registrationNumber: 'DR-XY99001', name: 'Paracelin' }, {});
    expect(calls).toHaveLength(2);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.records).toHaveLength(2);
    expect(r.advisories).toEqual([]);
    expect(r.advisoriesUnchecked).toBe(true);
  });

  test('falls back to the name when the registration number finds nothing; at most 2 fetches', async () => {
    const { provider, calls } = setup(ok(EMPTY), ok());
    const r = await provider.search({ registrationNumber: 'DR-XY12345', name: 'Paracelin' }, {});
    expect(calls.map((c) => c.url)).toEqual([
      'https://verification.fda.gov.ph/api/search?q=DR-XY12345',
      'https://verification.fda.gov.ph/api/search?q=paracelin',
    ]);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.records).toHaveLength(2);
  });

  test('never more than 2 fetches per search even when both find nothing', async () => {
    const { provider, calls } = setup(ok(EMPTY));
    const r = await provider.search({ registrationNumber: 'DR-1', name: 'Nothingfound' }, {});
    expect(calls).toHaveLength(2);
    expect(r).toEqual({ kind: 'ok', records: [], advisories: [] });
  });

  test('advisory brand falls back to record brand names on a registration-only query', async () => {
    const { provider } = setup(ok());
    const r = await provider.search({ registrationNumber: 'DR-XY99001' }, {});
    expect(r.kind === 'ok' && r.advisories.length).toBe(1);
  });

  test('no usable query → not_attempted, no fetch', async () => {
    const { provider, calls } = setup(ok());
    expect(await provider.search({}, {})).toEqual({ kind: 'not_attempted' });
    expect(await provider.search({ registrationNumber: 'garbage', name: '  ' }, {})).toEqual({
      kind: 'not_attempted',
    });
    expect(calls).toHaveLength(0);
  });

  test('200 with cdrr: [] → ok with zero records', async () => {
    const { provider } = setup(ok(EMPTY));
    expect(await provider.search({ name: 'Paracelin' }, {})).toEqual({
      kind: 'ok',
      records: [],
      advisories: [],
    });
  });

  test('second identical query within TTL makes no fetch; after TTL it refetches', async () => {
    const { provider, calls, clock } = setup(ok());
    await provider.search({ name: 'Paracelin' }, {});
    clock.t = T0 + DAY - 1;
    const again = await provider.search({ name: ' paracelin ' }, {});
    expect(calls).toHaveLength(1);
    expect(again.kind === 'ok' && again.records).toHaveLength(2);
    clock.t = T0 + DAY;
    await provider.search({ name: 'Paracelin' }, {});
    expect(calls).toHaveLength(2);
  });

  test('unavailable results are not cached', async () => {
    const { provider, calls } = setup({ status: 500, body: 'oops' }, ok());
    expect((await provider.search({ name: 'Paracelin' }, {})).kind).toBe('unavailable');
    expect((await provider.search({ name: 'Paracelin' }, {})).kind).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  test('timeout (fetch never resolves) → unavailable', async () => {
    vi.useFakeTimers();
    const { provider, calls } = setup('hang');
    const p = provider.search({ name: 'Paracelin' }, {});
    await vi.advanceTimersByTimeAsync(5000);
    const r = await p;
    expect(r.kind).toBe('unavailable');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test.each([403, 429, 500])('HTTP %i → unavailable', async (status) => {
    const { provider, calls } = setup({ status, body: '{"cdrr":[],"fdawebsite":[]}' });
    const r = await provider.search({ registrationNumber: 'DR-XY99001', name: 'Paracelin' }, {});
    expect(r.kind).toBe('unavailable');
    // A failed lookup is not retried under the other term.
    expect(calls).toHaveLength(1);
  });

  test('network error → unavailable', async () => {
    const { provider } = setup(new Error('ECONNRESET'));
    expect((await provider.search({ name: 'Paracelin' }, {})).kind).toBe('unavailable');
  });

  test('200 with HTML body → unavailable', async () => {
    const { provider } = setup(ok('<!doctype html><html><body>Blocked</body></html>'));
    expect((await provider.search({ name: 'Paracelin' }, {})).kind).toBe('unavailable');
  });

  test.each([
    ['no arrays', '{"message":"ok"}'],
    ['cdrr not an array', '{"cdrr":{},"fdawebsite":[]}'],
    ['fdawebsite missing', '{"cdrr":[]}'],
    ['JSON array', '[]'],
    ['JSON null', 'null'],
  ])('200 JSON with %s → unavailable', async (_n, body) => {
    const { provider } = setup(ok(body));
    expect((await provider.search({ name: 'Paracelin' }, {})).kind).toBe('unavailable');
  });
});
