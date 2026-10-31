import type { AnalysisEvent, AnalysisResult, AnalysisStatus, Answer } from '@medilens/contracts';
import { AnalysisResultSchema } from '@medilens/contracts';
import {
  ANALYZE_TIMEOUT_MS,
  ApiError,
  POLL_INTERVAL_MS,
  POLL_MAX_RETRIES,
  REQUEST_TIMEOUT_MS,
  createApiClient,
} from '../../src/api/client';
import { CAPABILITIES, S1_CREATED, S1_STATUS } from '../helpers/fixtures';

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

/** A part as React Native's FormData.getParts() reports it. */
interface FormPart {
  fieldName: string;
  name: string;
  type: string;
  bytes(): Promise<Uint8Array>;
}

/** Response headers, looked up case-insensitively as the Fetch Headers class does. */
function headersOf(values: Record<string, string> = {}) {
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headersOf(headers),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A 204: no body, so json() fails as it does on a real empty response. */
function emptyResponse(status = 204): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headersOf(),
    json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
  } as unknown as Response;
}

/** A body that is not JSON, such as a proxy's HTML error page. */
function htmlResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headersOf({ 'Content-Type': 'text/html' }),
    json: () => Promise.reject(new SyntaxError('Unexpected token <')),
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

/**
 * The Go API's analysis endpoints, scripted in order: each fetch call takes
 * the next step, which must be for the same method and URL. A step answers a
 * JSON body (with optional headers), a 204, a non-JSON page, a rejection
 * (the network failed), or nothing until the request is aborted (a stall).
 */
type Step =
  | {
      method: string;
      url: string;
      status?: number;
      body: unknown;
      headers?: Record<string, string>;
    }
  | { method: string; url: string; empty: true }
  | { method: string; url: string; html: number }
  | { method: string; url: string; reject: Error }
  | { method: string; url: string; hang: true };

function scriptedFetch(steps: Step[]) {
  const queue = [...steps];
  const calls: string[] = [];
  const fetchImpl = jest.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const step = queue.shift();
    if (step === undefined) throw new Error(`unexpected fetch: ${method} ${url}`);
    expect(`${method} ${url}`).toBe(`${step.method} ${step.url}`);
    if ('reject' in step) return Promise.reject(step.reject);
    if ('empty' in step) return Promise.resolve(emptyResponse());
    if ('html' in step) return Promise.resolve(htmlResponse(step.html));
    if ('hang' in step) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }
    return Promise.resolve(jsonResponse(step.body, step.status ?? 200, step.headers));
  });
  return { fetchImpl, calls, remaining: () => queue.length };
}

/** Real Go API bodies (test/fixtures/go-s1.*.json), cut to the stages seen so far. */
const ID = S1_CREATED.id;
const ANALYSES = `${BASE}/api/v1/analyses`;
const EVENTS = S1_STATUS.events;

function processing(upTo: number): AnalysisStatus {
  const events = EVENTS.slice(0, upTo);
  return { ...S1_STATUS, status: 'processing', stage: events.at(-1)!.stage, events };
}

const FAILED_MESSAGE = "I couldn't read the label right now. Please try again.";
const failed: AnalysisStatus = {
  id: ID,
  status: 'failed',
  stage: 'failed',
  events: [
    ...EVENTS.slice(0, 2),
    { seq: 3, stage: 'failed', label: FAILED_MESSAGE, at: EVENTS[1]!.at },
  ],
  error: { code: 'OCR_FAILED', message: FAILED_MESSAGE, requestId: 'req-9' },
  isDemo: false,
};

const notReady = {
  error: {
    code: 'ANALYSIS_NOT_READY',
    message: 'The analysis is still running. Please try again in a moment.',
    requestId: 'req-2',
  },
};

describe('createApiClient', () => {
  it('imports the shared contracts from the workspace package', () => {
    expect(AnalysisResultSchema.safeParse(result).success).toBe(true);
  });

  it('strips trailing slashes from the base URL', async () => {
    const fetchImpl = fetchReturning(result);
    await createApiClient(`${BASE}//`, fetchImpl).result('r-1');
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${BASE}/api/v1/analyses/r-1/result`);
  });

  it('throws INVALID_RESPONSE when a 200 body does not match the schema', async () => {
    const client = createApiClient(BASE, fetchReturning({ ...result, imageRetention: 'kept' }));
    const err = await caught(client.result('r-1'));
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

  it("maps the Go API's own error codes too", async () => {
    const err = await caught(createApiClient(BASE, fetchReturning(notReady, 409)).result('r-1'));
    expect(err.code).toBe('ANALYSIS_NOT_READY');
    expect(err.message).toBe(notReady.error.message);
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

    it('gives the analyze upload 60 s before TIMEOUT', async () => {
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

    // Final review Minor 22: leaving the analyzing screen stops the upload.
    it('stops an analyze upload when the caller aborts, with CANCELLED', async () => {
      const fetchImpl = hangingFetch();
      const controller = new AbortController();
      const pending = caught(
        createApiClient(BASE, fetchImpl).analyze([{ uri: 'file:///a.jpg', type: 'image/jpeg' }], {
          signal: controller.signal,
        }),
      );
      await jest.advanceTimersByTimeAsync(1_000);
      const sent = fetchImpl.mock.calls[0]![1]!.signal!;
      expect(sent.aborted).toBe(false);
      controller.abort();
      const err = await pending;
      expect(err.code).toBe('CANCELLED');
      expect(sent.aborted).toBe(true);
    });

    it('never sends an analyze upload whose signal is already aborted', async () => {
      const fetchImpl = hangingFetch();
      const controller = new AbortController();
      controller.abort();
      const err = await caught(
        createApiClient(BASE, fetchImpl).analyze([{ uri: 'file:///a.jpg', type: 'image/jpeg' }], {
          signal: controller.signal,
        }),
      );
      expect(err.code).toBe('CANCELLED');
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  // Go port spec §7: POST, poll GET /analyses/{id} every 750 ms, then GET /result.
  describe('analysis polling', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('scenario posts, polls every 750 ms reporting each new stage, then fetches the result', async () => {
      expect(POLL_INTERVAL_MS).toBe(750);
      const script = scriptedFetch([
        { method: 'POST', url: `${BASE}/api/v1/demo/scenarios`, status: 202, body: S1_CREATED },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: processing(1) },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: processing(3) },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: processing(3) },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: S1_STATUS },
        { method: 'GET', url: `${ANALYSES}/${ID}/result`, body: result },
      ]);
      const stages: AnalysisEvent[] = [];
      let done: AnalysisResult | undefined;
      void createApiClient(BASE, script.fetchImpl)
        .scenario('s1-clear', { onStage: (e) => stages.push(e) })
        .then((r) => (done = r));

      await jest.advanceTimersByTimeAsync(0);
      expect(script.calls).toHaveLength(2);
      const [, init] = script.fetchImpl.mock.calls[0]!;
      expect(JSON.parse(String(init?.body))).toEqual({ scenarioId: 's1-clear' });
      expect(stages.map((e) => e.label)).toEqual(['Request received.']);

      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
      expect(script.calls).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(script.calls).toHaveLength(3);
      // Only the newest event of a poll is reported, once.
      expect(stages.map((e) => e.label)).toEqual(['Request received.', 'Reviewing what was read.']);

      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(script.calls).toHaveLength(4);
      expect(stages).toHaveLength(2);

      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(script.remaining()).toBe(0);
      expect(done).toEqual(result);
      expect(stages.at(-1)).toEqual(EVENTS.at(-1));
      await jest.advanceTimersByTimeAsync(10 * POLL_INTERVAL_MS);
      expect(script.calls).toHaveLength(6);
    });

    it('analyze uploads to POST /analyses, then polls the same way', async () => {
      const script = scriptedFetch([
        { method: 'POST', url: ANALYSES, status: 202, body: S1_CREATED },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: S1_STATUS },
        { method: 'GET', url: `${ANALYSES}/${ID}/result`, body: result },
      ]);
      const pending = createApiClient(BASE, script.fetchImpl).analyze([
        { uri: 'file:///cache/a.jpg', type: 'image/jpeg' },
      ]);
      await jest.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toEqual(result);
    });

    it('a failed analysis rejects with its stored error and never asks for the result', async () => {
      const script = scriptedFetch([
        { method: 'POST', url: ANALYSES, status: 202, body: S1_CREATED },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: processing(1) },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: failed },
      ]);
      const stages: string[] = [];
      const pending = caught(
        createApiClient(BASE, script.fetchImpl).analyze(
          [{ uri: 'file:///cache/a.jpg', type: 'image/jpeg' }],
          { onStage: (e) => stages.push(e.stage) },
        ),
      );
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      const err = await pending;
      expect(err.code).toBe('OCR_FAILED');
      expect(err.message).toBe(FAILED_MESSAGE);
      expect(stages).toEqual(['received', 'failed']);
      await jest.advanceTimersByTimeAsync(10 * POLL_INTERVAL_MS);
      expect(script.calls).toHaveLength(3);
    });

    // Final review I1: a live read is 40-120 polls, so one transient failure
    // must not end the scan (and re-spend the model call on "Try again").
    const offline = () => ({
      method: 'GET',
      url: `${ANALYSES}/${ID}`,
      reject: new TypeError('Network request failed'),
    });

    it('gives up after 3 retries of a failing poll with NETWORK, stops polling and deletes the analysis', async () => {
      expect(POLL_MAX_RETRIES).toBe(3);
      const script = scriptedFetch([
        { method: 'POST', url: ANALYSES, status: 202, body: S1_CREATED },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: processing(1) },
        offline(),
        offline(),
        offline(),
        offline(),
        // Best effort: the client gave up, so the server's copy is dropped.
        { method: 'DELETE', url: `${ANALYSES}/${ID}`, empty: true },
      ]);
      let settled = false;
      const pending = caught(
        createApiClient(BASE, script.fetchImpl).analyze([
          { uri: 'file:///cache/a.jpg', type: 'image/jpeg' },
        ]),
      ).finally(() => {
        settled = true;
      });
      // Polls at 750 ms, then backs off 1.5 s, 3 s and 6 s after each failure.
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(script.calls).toHaveLength(3);
      await jest.advanceTimersByTimeAsync(1_500);
      expect(script.calls).toHaveLength(4);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(script.calls).toHaveLength(5);
      await jest.advanceTimersByTimeAsync(6_000 - 1);
      expect(script.calls).toHaveLength(5);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect((await pending).code).toBe('NETWORK');
      await jest.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
      expect(script.calls).toEqual([
        `POST ${ANALYSES}`,
        ...Array.from({ length: 5 }, () => `GET ${ANALYSES}/${ID}`),
        `DELETE ${ANALYSES}/${ID}`,
      ]);
    });

    it('recovers after one failed poll: the scan goes on to its result', async () => {
      const script = scriptedFetch([
        { method: 'POST', url: ANALYSES, status: 202, body: S1_CREATED },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: processing(1) },
        offline(),
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: processing(3) },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: S1_STATUS },
        { method: 'GET', url: `${ANALYSES}/${ID}/result`, body: result },
      ]);
      const stages: string[] = [];
      let done: AnalysisResult | undefined;
      void createApiClient(BASE, script.fetchImpl)
        .analyze([{ uri: 'file:///cache/a.jpg', type: 'image/jpeg' }], {
          onStage: (e) => stages.push(e.label),
        })
        .then((r) => (done = r));
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1_500 + POLL_INTERVAL_MS);
      expect(script.remaining()).toBe(0);
      expect(done).toEqual(result);
      expect(stages).toEqual([
        'Request received.',
        'Reviewing what was read.',
        EVENTS.at(-1)!.label,
      ]);
      await jest.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
      expect(script.calls).not.toContain(`DELETE ${ANALYSES}/${ID}`);
    });

    it.each<[string, Step]>([
      ['a stalled poll (TIMEOUT)', { method: 'GET', url: `${ANALYSES}/${ID}`, hang: true }],
      ['a proxy 502 page', { method: 'GET', url: `${ANALYSES}/${ID}`, html: 502 }],
      ['a 503 page', { method: 'GET', url: `${ANALYSES}/${ID}`, html: 503 }],
      [
        'a 429 without Retry-After',
        {
          method: 'GET',
          url: `${ANALYSES}/${ID}`,
          status: 429,
          body: {
            error: {
              code: 'RATE_LIMITED',
              message: 'Too many requests. Please wait a minute and try again.',
              requestId: 'req-5',
            },
          },
        },
      ],
    ])('retries after %s and recovers', async (_name, failure) => {
      const script = scriptedFetch([
        { method: 'POST', url: ANALYSES, status: 202, body: S1_CREATED },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: processing(1) },
        failure,
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: S1_STATUS },
        { method: 'GET', url: `${ANALYSES}/${ID}/result`, body: result },
      ]);
      let done: AnalysisResult | undefined;
      void createApiClient(BASE, script.fetchImpl)
        .analyze([{ uri: 'file:///cache/a.jpg', type: 'image/jpeg' }])
        .then((r) => (done = r));
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + REQUEST_TIMEOUT_MS + 1_500);
      expect(script.remaining()).toBe(0);
      expect(done).toEqual(result);
      expect(script.calls).not.toContain(`DELETE ${ANALYSES}/${ID}`);
    });

    it('waits out a 429 Retry-After before polling again', async () => {
      const script = scriptedFetch([
        { method: 'POST', url: ANALYSES, status: 202, body: S1_CREATED },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: processing(1) },
        {
          method: 'GET',
          url: `${ANALYSES}/${ID}`,
          status: 429,
          headers: { 'Retry-After': '4' },
          body: {
            error: {
              code: 'RATE_LIMITED',
              message: 'Too many requests. Please wait a minute and try again.',
              requestId: 'req-6',
            },
          },
        },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: S1_STATUS },
        { method: 'GET', url: `${ANALYSES}/${ID}/result`, body: result },
      ]);
      let done: AnalysisResult | undefined;
      void createApiClient(BASE, script.fetchImpl)
        .analyze([{ uri: 'file:///cache/a.jpg', type: 'image/jpeg' }])
        .then((r) => (done = r));
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(script.calls).toHaveLength(3);
      // The 1.5 s backoff is shorter than the server's 4 s, so the server wins.
      await jest.advanceTimersByTimeAsync(4_000 - 1);
      expect(script.calls).toHaveLength(3);
      await jest.advanceTimersByTimeAsync(1);
      expect(script.remaining()).toBe(0);
      expect(done).toEqual(result);
    });

    it('a run of failures resets on each successful poll', async () => {
      const script = scriptedFetch([
        { method: 'POST', url: ANALYSES, status: 202, body: S1_CREATED },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: processing(1) },
        offline(),
        offline(),
        offline(),
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: processing(2) },
        offline(),
        offline(),
        offline(),
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: S1_STATUS },
        { method: 'GET', url: `${ANALYSES}/${ID}/result`, body: result },
      ]);
      let done: AnalysisResult | undefined;
      void createApiClient(BASE, script.fetchImpl)
        .analyze([{ uri: 'file:///cache/a.jpg', type: 'image/jpeg' }])
        .then((r) => (done = r));
      await jest.advanceTimersByTimeAsync(2 * (POLL_INTERVAL_MS + 1_500 + 3_000 + 6_000));
      expect(script.remaining()).toBe(0);
      expect(done).toEqual(result);
    });

    it('a transient failure fetching the result is retried too', async () => {
      const script = scriptedFetch([
        { method: 'POST', url: ANALYSES, status: 202, body: S1_CREATED },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: S1_STATUS },
        { method: 'GET', url: `${ANALYSES}/${ID}/result`, html: 502 },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: S1_STATUS },
        { method: 'GET', url: `${ANALYSES}/${ID}/result`, body: result },
      ]);
      let done: AnalysisResult | undefined;
      void createApiClient(BASE, script.fetchImpl)
        .analyze([{ uri: 'file:///cache/a.jpg', type: 'image/jpeg' }])
        .then((r) => (done = r));
      await jest.advanceTimersByTimeAsync(1_500);
      expect(script.remaining()).toBe(0);
      expect(done).toEqual(result);
    });

    it('a result that keeps failing still runs out of retries though its status answers', async () => {
      const done = { method: 'GET', url: `${ANALYSES}/${ID}`, body: S1_STATUS };
      const page = { method: 'GET', url: `${ANALYSES}/${ID}/result`, html: 502 };
      const script = scriptedFetch([
        { method: 'POST', url: ANALYSES, status: 202, body: S1_CREATED },
        ...Array.from({ length: POLL_MAX_RETRIES + 1 }, () => [done, page]).flat(),
        { method: 'DELETE', url: `${ANALYSES}/${ID}`, empty: true },
      ]);
      const pending = caught(
        createApiClient(BASE, script.fetchImpl).analyze([
          { uri: 'file:///cache/a.jpg', type: 'image/jpeg' },
        ]),
      );
      await jest.advanceTimersByTimeAsync(1_500 + 3_000 + 6_000);
      expect((await pending).code).toBe('INTERNAL_ERROR');
      await jest.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
      expect(script.remaining()).toBe(0);
    });

    it('an answer the app cannot read ends the wait at once and deletes the analysis', async () => {
      const script = scriptedFetch([
        { method: 'POST', url: ANALYSES, status: 202, body: S1_CREATED },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: { status: 'thinking' } },
        { method: 'DELETE', url: `${ANALYSES}/${ID}`, empty: true },
      ]);
      const pending = caught(
        createApiClient(BASE, script.fetchImpl).analyze([
          { uri: 'file:///cache/a.jpg', type: 'image/jpeg' },
        ]),
      );
      expect((await pending).code).toBe('INVALID_RESPONSE');
      await jest.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
      expect(script.calls).toEqual([
        `POST ${ANALYSES}`,
        `GET ${ANALYSES}/${ID}`,
        `DELETE ${ANALYSES}/${ID}`,
      ]);
    });

    it('NOT_FOUND ends the wait without retrying or deleting: the server no longer has it', async () => {
      const script = scriptedFetch([
        { method: 'POST', url: ANALYSES, status: 202, body: S1_CREATED },
        {
          method: 'GET',
          url: `${ANALYSES}/${ID}`,
          status: 404,
          body: {
            error: {
              code: 'NOT_FOUND',
              message: 'This scan result has expired or does not exist. Please scan again.',
              requestId: 'req-7',
            },
          },
        },
      ]);
      const pending = caught(
        createApiClient(BASE, script.fetchImpl).analyze([
          { uri: 'file:///cache/a.jpg', type: 'image/jpeg' },
        ]),
      );
      expect((await pending).code).toBe('NOT_FOUND');
      await jest.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
      expect(script.calls).toHaveLength(2);
    });

    it('an abort during a retry backoff rejects CANCELLED and deletes the analysis', async () => {
      const script = scriptedFetch([
        { method: 'POST', url: ANALYSES, status: 202, body: S1_CREATED },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: processing(1) },
        offline(),
        { method: 'DELETE', url: `${ANALYSES}/${ID}`, empty: true },
      ]);
      const controller = new AbortController();
      const pending = caught(
        createApiClient(BASE, script.fetchImpl).analyze(
          [{ uri: 'file:///cache/a.jpg', type: 'image/jpeg' }],
          { signal: controller.signal },
        ),
      );
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 500);
      expect(script.calls).toHaveLength(3);
      controller.abort();
      expect((await pending).code).toBe('CANCELLED');
      await jest.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
      expect(script.remaining()).toBe(0);
    });

    it('ANALYSIS_NOT_READY from /result waits 750 ms and polls again', async () => {
      const script = scriptedFetch([
        { method: 'POST', url: `${BASE}/api/v1/demo/scenarios`, status: 202, body: S1_CREATED },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: S1_STATUS },
        { method: 'GET', url: `${ANALYSES}/${ID}/result`, status: 409, body: notReady },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: S1_STATUS },
        { method: 'GET', url: `${ANALYSES}/${ID}/result`, body: result },
      ]);
      let done: AnalysisResult | undefined;
      void createApiClient(BASE, script.fetchImpl)
        .scenario('s1-clear')
        .then((r) => (done = r));
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
      expect(script.calls).toHaveLength(3);
      expect(done).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      expect(script.remaining()).toBe(0);
      expect(done).toEqual(result);
    });

    it('an abort between polls rejects CANCELLED, stops polling and deletes the analysis', async () => {
      const script = scriptedFetch([
        { method: 'POST', url: ANALYSES, status: 202, body: S1_CREATED },
        { method: 'GET', url: `${ANALYSES}/${ID}`, body: processing(2) },
        // Best effort: a failed delete is not the caller's problem.
        { method: 'DELETE', url: `${ANALYSES}/${ID}`, reject: new TypeError('offline') },
      ]);
      const controller = new AbortController();
      const pending = caught(
        createApiClient(BASE, script.fetchImpl).analyze(
          [{ uri: 'file:///cache/a.jpg', type: 'image/jpeg' }],
          { signal: controller.signal },
        ),
      );
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS / 2);
      expect(script.calls).toHaveLength(2);
      controller.abort();
      expect((await pending).code).toBe('CANCELLED');
      await jest.advanceTimersByTimeAsync(10 * POLL_INTERVAL_MS);
      expect(script.calls).toEqual([
        `POST ${ANALYSES}`,
        `GET ${ANALYSES}/${ID}`,
        `DELETE ${ANALYSES}/${ID}`,
      ]);
    });
  });

  it('uploads images as multipart under the "images" field', async () => {
    const script = scriptedFetch([
      { method: 'POST', url: ANALYSES, status: 202, body: S1_CREATED },
      { method: 'GET', url: `${ANALYSES}/${ID}`, body: S1_STATUS },
      { method: 'GET', url: `${ANALYSES}/${ID}/result`, body: result },
    ]);
    const client = createApiClient(BASE, script.fetchImpl);
    await expect(
      client.analyze([
        { uri: 'file:///cache/a.jpg', type: 'image/jpeg' },
        { uri: 'file:///cache/b.jpg', type: 'image/jpeg' },
      ]),
    ).resolves.toEqual(result);
    const [, init] = script.fetchImpl.mock.calls[0]!;
    const parts = (init?.body as unknown as { getParts(): FormPart[] }).getParts();
    expect(parts).toHaveLength(2);
    // A file part expo/fetch can encode (name, type, bytes()), not React
    // Native's {uri, name, type}; test/api/multipart.test.ts runs the encoder.
    expect(parts[0]).toMatchObject({
      fieldName: 'images',
      name: 'photo-1.jpg',
      type: 'image/jpeg',
    });
    expect(parts[1]).toMatchObject({
      fieldName: 'images',
      name: 'photo-2.jpg',
      type: 'image/jpeg',
    });
    expect(parts[0]).not.toHaveProperty('uri');
    // jest.setup's expo-file-system File mock reads a file as `bytes of <uri>`.
    const bytes = await parts[0]!.bytes();
    expect(new TextDecoder().decode(bytes)).toBe('bytes of file:///cache/a.jpg');
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
    expect(url).toBe(`${BASE}/api/v1/analyses/r%201/explanation`);
    expect(init?.method).toBe('POST');
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
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${BASE}/api/v1/analyses/r-1/references`);
  });

  it('reads the server capabilities (mode detection replaces /health)', async () => {
    const fetchImpl = fetchReturning(CAPABILITIES);
    await expect(createApiClient(BASE, fetchImpl).capabilities()).resolves.toEqual(CAPABILITIES);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${BASE}/api/v1/config/capabilities`);
  });

  it('deletes an analysis: a 204 with no body resolves', async () => {
    const script = scriptedFetch([{ method: 'DELETE', url: `${ANALYSES}/r%201`, empty: true }]);
    await expect(createApiClient(BASE, script.fetchImpl).deleteAnalysis('r 1')).resolves.toBe(
      undefined,
    );
  });

  it('a delete of an analysis the server no longer has rejects NOT_FOUND', async () => {
    const body = {
      error: {
        code: 'NOT_FOUND',
        message: 'This scan result has expired or does not exist. Please scan again.',
        requestId: 'req-3',
      },
    };
    const err = await caught(createApiClient(BASE, fetchReturning(body, 404)).deleteAnalysis('x'));
    expect(err.code).toBe('NOT_FOUND');
  });
});
