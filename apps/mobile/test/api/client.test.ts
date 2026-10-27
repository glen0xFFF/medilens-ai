import type { AnalysisResult, Answer } from '@medilens/contracts';
import { AnalysisResultSchema } from '@medilens/contracts';
import {
  ANALYZE_TIMEOUT_MS,
  ApiError,
  REQUEST_TIMEOUT_MS,
  createApiClient,
} from '../../src/api/client';

const BASE = 'http://example.test:8787';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:15:00.000Z';

const result: AnalysisResult = {
  id: 'r-1',
  isDemo: true,
  createdAt: NOW,
  expiresAt: LATER,
  pipelineState: 'explanation_ready',
  quality: { ok: true, sharpness: 30, luminance: 120, glareFraction: 0.01, reasons: [] },
  label: {
    imageKind: 'label',
    fields: [
      {
        key: 'brandName',
        value: 'Paracet',
        legibility: 'clear',
        evidenceText: 'PARACET',
        imageIndex: 0,
        notes: null,
      },
    ],
    rawText: 'PARACET 500 mg',
    warnings: [],
  },
  match: {
    status: 'verified',
    matched: ['brandName'],
    conflicting: [],
    missing: [],
    candidates: [],
    advisories: [],
    limitations: [],
  },
  explanation: {
    displayText: 'DEMO DATA. Paracet.',
    spokenChunks: ['DEMO DATA.', 'Paracet.'],
    safetyNotices: [],
    supportingFields: ['brandName'],
  },
  imageRetention: 'none',
};

const answer: Answer = {
  status: 'answered',
  text: 'The label says Paracet.',
  spokenChunks: ['The label says Paracet.'],
  citedFields: ['brandName'],
  safetyNotice: null,
};

interface FormPart {
  fieldName: string;
  uri: string;
  name: string;
  type: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function fetchReturning(body: unknown, status = 200) {
  return jest.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(jsonResponse(body, status)),
  );
}

async function caught(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw new Error(`expected ApiError, got ${String(e)}`, { cause: e });
  }
  throw new Error('expected the call to throw');
}

describe('createApiClient', () => {
  it('imports the shared contracts from the workspace package', () => {
    expect(AnalysisResultSchema.safeParse(result).success).toBe(true);
  });

  it('parses a valid demo scenario result', async () => {
    const fetchImpl = fetchReturning(result);
    const client = createApiClient(BASE, fetchImpl);
    await expect(client.scenario('s1-clear')).resolves.toEqual(result);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/v1/demo/scenario`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ scenarioId: 's1-clear' });
  });

  it('strips trailing slashes from the base URL', async () => {
    const fetchImpl = fetchReturning(result);
    await createApiClient(`${BASE}//`, fetchImpl).result('r-1');
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${BASE}/api/v1/labels/r-1`);
  });

  it('throws INVALID_RESPONSE when a 200 body does not match the schema', async () => {
    const client = createApiClient(BASE, fetchReturning({ ...result, imageRetention: 'kept' }));
    const err = await caught(client.scenario('s1-clear'));
    expect(err.code).toBe('INVALID_RESPONSE');
  });

  it('throws INVALID_RESPONSE when a 200 body is not JSON', async () => {
    const fetchImpl = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      } as unknown as Response),
    );
    const err = await caught(createApiClient(BASE, fetchImpl).scenarios());
    expect(err.code).toBe('INVALID_RESPONSE');
  });

  it('maps a 429 error body to ApiError RATE_LIMITED with the server message', async () => {
    const body = {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please wait a minute and try again.',
        requestId: 'req-1',
      },
    };
    const err = await caught(createApiClient(BASE, fetchReturning(body, 429)).scenarios());
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.message).toBe('Too many requests. Please wait a minute and try again.');
  });

  it('maps a non-2xx response without a valid error body to INTERNAL_ERROR', async () => {
    const client = createApiClient(BASE, fetchReturning('<html>bad gateway</html>', 502));
    const err = await caught(client.scenarios());
    expect(err.code).toBe('INTERNAL_ERROR');
  });

  it('maps a fetch rejection to NETWORK', async () => {
    const fetchImpl = jest.fn(() => Promise.reject(new TypeError('Network request failed')));
    const err = await caught(createApiClient(BASE, fetchImpl).scenarios());
    expect(err.code).toBe('NETWORK');
  });

  describe('timeouts', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    /** A fetch that never settles until its signal aborts, like a stalled server. */
    function hangingFetch() {
      return jest.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const e = new Error('Aborted');
              e.name = 'AbortError';
              reject(e);
            });
          }),
      );
    }

    it('aborts an ordinary request after 15 s with TIMEOUT', async () => {
      expect(REQUEST_TIMEOUT_MS).toBe(15_000);
      const pending = caught(createApiClient(BASE, hangingFetch()).scenarios());
      await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      expect((await pending).code).toBe('TIMEOUT');
    });

    it('gives analyze 60 s before TIMEOUT', async () => {
      expect(ANALYZE_TIMEOUT_MS).toBe(60_000);
      let settled = false;
      const pending = caught(
        createApiClient(BASE, hangingFetch()).analyze([
          { uri: 'file:///a.jpg', type: 'image/jpeg' },
        ]),
      ).finally(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(ANALYZE_TIMEOUT_MS);
      expect((await pending).code).toBe('TIMEOUT');
    });
  });

  it('uploads images as multipart under the "images" field', async () => {
    const fetchImpl = fetchReturning(result);
    const client = createApiClient(BASE, fetchImpl);
    await expect(
      client.analyze([
        { uri: 'file:///cache/a.jpg', type: 'image/jpeg' },
        { uri: 'file:///cache/b.jpg', type: 'image/jpeg' },
      ]),
    ).resolves.toEqual(result);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/v1/labels/analyze`);
    expect(init?.method).toBe('POST');
    const parts = (init?.body as unknown as { getParts(): FormPart[] }).getParts();
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      fieldName: 'images',
      uri: 'file:///cache/a.jpg',
      type: 'image/jpeg',
    });
    expect(parts[1]).toMatchObject({ fieldName: 'images', uri: 'file:///cache/b.jpg' });
    expect(parts[0]!.name).toMatch(/\.jpg$/);
  });

  it('rejects 0 or more than 3 images before calling the server', async () => {
    const fetchImpl = fetchReturning(result);
    const client = createApiClient(BASE, fetchImpl);
    const img = { uri: 'file:///a.jpg', type: 'image/jpeg' };
    expect((await caught(client.analyze([]))).code).toBe('VALIDATION_FAILED');
    expect((await caught(client.analyze([img, img, img, img]))).code).toBe('VALIDATION_FAILED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks a question and parses the Answer', async () => {
    const fetchImpl = fetchReturning(answer);
    const client = createApiClient(BASE, fetchImpl);
    await expect(client.explain('r 1', 'Can you read this label?')).resolves.toEqual(answer);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/v1/labels/r%201/explain`);
    expect(JSON.parse(String(init?.body))).toEqual({ question: 'Can you read this label?' });
  });

  it('lists demo scenarios', async () => {
    const list = [{ id: 's1-clear', title: 'Clear label' }];
    const fetchImpl = fetchReturning(list);
    await expect(createApiClient(BASE, fetchImpl).scenarios()).resolves.toEqual(list);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${BASE}/api/v1/demo/scenarios`);
  });

  it('lists preset questions and rejects a non-string list', async () => {
    const presets = ['Can you read this label?', 'Which parts were unclear?'];
    const fetchImpl = fetchReturning(presets);
    await expect(createApiClient(BASE, fetchImpl).presets()).resolves.toEqual(presets);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${BASE}/api/v1/questions/presets`);
    const err = await caught(createApiClient(BASE, fetchReturning([1, 2])).presets());
    expect(err.code).toBe('INVALID_RESPONSE');
  });

  it('fetches references for a stored analysis', async () => {
    const refs = {
      candidates: [],
      advisories: [{ title: 'Advisory', url: 'https://www.fda.gov.ph/advisory-1' }],
      limitations: ['Demo data.'],
      checkedAt: null,
    };
    const fetchImpl = fetchReturning(refs);
    await expect(createApiClient(BASE, fetchImpl).references('r-1')).resolves.toEqual(refs);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${BASE}/api/v1/references/r-1`);
  });

  it('checks health at the server root', async () => {
    const health = { status: 'ok', version: '0.1.0', providerMode: 'demo' };
    const fetchImpl = fetchReturning(health);
    await expect(createApiClient(BASE, fetchImpl).health()).resolves.toEqual(health);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${BASE}/health`);
  });
});
