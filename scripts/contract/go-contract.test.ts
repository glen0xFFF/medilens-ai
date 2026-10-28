/**
 * Cross-language contract test (Go port spec §6.6, §6.7; plan task G9):
 * the Go API, built and started in mock + fixture mode, answers every
 * route with bodies the Zod contracts accept, and accept without stripping
 * anything (an extra or renamed key is a failure, as are null for [] and
 * an omitted nullable). The 8 demo scenarios through Go POST
 * /demo/scenarios then GET /result equal the Node POST /demo/scenario
 * results recorded in fixtures/parity/scenarios.jsonl (ruling R3), id and
 * timestamps excepted.
 *
 * The API allows 30 writes (POST, DELETE) a minute per client, so this file
 * sends fewer than 30 before the last test, which spends the rest to see
 * the 429.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AnalysisCreatedSchema,
  AnalysisEventNameSchema,
  AnalysisEventSchema,
  AnalysisReferencesSchema,
  AnalysisResultSchema,
  AnalysisStatusSchema,
  AnswerSchema,
  ApiErrorBodySchema,
  CapabilitiesSchema,
  DemoScenarioListSchema,
  DemoScenarioRequestSchema,
  ExplainRequestSchema,
  HealthzSchema,
  PresetQuestionsSchema,
  ReadyzSchema,
  SpeakRequestSchema,
  SpeechSchema,
  type AnalysisEvent,
  type AnalysisResult,
  type ApiErrorCode,
} from '@medilens/contracts';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { parseSse, repoRoot, startGoApi, type GoApi } from './go-api';

/** Set in the API's environment (mock mode reads but never uses it); no response may echo it. */
const SENTINEL_KEY = 'contract-sentinel-not-a-real-key-7f3a';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STACK_TEXT = /goroutine|\.go:\d|panic|runtime\.|\n\s+at /;

interface Recorded {
  fn: string;
  args: [{ scenarioId: string }];
  result: Record<string, unknown>;
}

const fixturesDir = join(repoRoot, 'fixtures', 'parity');
const recorded: Recorded[] = readFileSync(join(fixturesDir, 'scenarios.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as Recorded);
const image = (name: string) => readFileSync(join(fixturesDir, 'images', name));

let api: GoApi;
const bodies: string[] = [];

beforeAll(async () => {
  api = await startGoApi({ MODEL_API_KEY: SENTINEL_KEY });
});

afterAll(async () => {
  await api?.stop();
});

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  body: unknown;
}

async function call(method: string, path: string, init: RequestInit = {}): Promise<Reply> {
  const res = await fetch(`${api.baseUrl}${path}`, {
    ...init,
    method,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  bodies.push(text);
  let body: unknown = undefined;
  if ((res.headers.get('content-type') ?? '').startsWith('application/json')) {
    body = JSON.parse(text);
  }
  return { status: res.status, headers: res.headers, text, body };
}

const get = (path: string) => call('GET', path);

function postJSON(path: string, body: unknown): Promise<Reply> {
  return call('POST', path, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function upload(...images: { bytes: Uint8Array; type: string; name: string }[]): Promise<Reply> {
  const form = new FormData();
  for (const img of images) {
    form.append('images', new Blob([new Uint8Array(img.bytes)], { type: img.type }), img.name);
  }
  return call('POST', '/api/v1/analyses', { body: form });
}

/**
 * The body satisfies the schema, and parsing it loses nothing: Zod strips
 * unknown keys, so a strict equality with the input catches every key the
 * contract does not name, at any depth.
 */
function expectContract<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`${z.prettifyError(parsed.error)}\nbody: ${JSON.stringify(body)}`);
  }
  expect(parsed.data).toStrictEqual(body);
  return parsed.data;
}

function expectOk<S extends z.ZodType>(reply: Reply, status: number, schema: S): z.infer<S> {
  if (reply.status !== status) throw new Error(`status ${reply.status}: ${reply.text}`);
  expect(reply.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(reply.headers.get('x-request-id')).toMatch(UUID_V4);
  return expectContract(schema, reply.body);
}

/** An error response: the contract body, this request's id, no stack text. */
function expectError(reply: Reply, status: number, code: ApiErrorCode): string {
  expect(reply.status, reply.text).toBe(status);
  expect(reply.headers.get('content-type')).toBe('application/json; charset=utf-8');
  const { error } = expectContract(ApiErrorBodySchema, reply.body);
  expect(error.code).toBe(code);
  expect(error.requestId).toBe(reply.headers.get('x-request-id'));
  expect(error.requestId).toMatch(UUID_V4);
  expect(reply.text).not.toMatch(STACK_TEXT);
  return error.message;
}

/** Reads the event stream of an analysis to its end (the server ends it after the terminal event). */
async function events(id: string): Promise<{ name: string; event: AnalysisEvent }[]> {
  const res = await fetch(`${api.baseUrl}/api/v1/analyses/${id}/events`, {
    signal: AbortSignal.timeout(20_000),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/event-stream');
  const text = await res.text();
  bodies.push(text);
  const frames = parseSse(text);
  const out = frames.map((frame) => {
    const event = expectContract(AnalysisEventSchema, JSON.parse(frame.data ?? 'null'));
    const name = AnalysisEventNameSchema.parse(frame.event);
    expect(frame.id).toBe(String(event.seq));
    return { name, event };
  });
  // seq counts from 1 with no gap; received first; one terminal event, last
  expect(out.map((e) => e.event.seq)).toEqual(out.map((_, i) => i + 1));
  expect(out[0]?.event.stage).toBe('received');
  out.forEach(({ name, event }, i) => {
    const terminal = ['completed', 'needs_attention', 'failed'].includes(event.stage);
    expect(terminal).toBe(i === out.length - 1);
    const expected = event.stage === 'failed' ? 'failed' : terminal ? 'completed' : 'stage';
    expect(name).toBe(expected);
  });
  return out;
}

/** The result's own id and timestamps, checked; the rest returned for comparison. */
function withoutIdAndTimes(result: AnalysisResult, id: string): Record<string, unknown> {
  const { id: resultId, createdAt, expiresAt, ...rest } = result;
  expect(resultId).toBe(id);
  expect(Date.parse(expiresAt) - Date.parse(createdAt)).toBe(900_000);
  return rest;
}

describe('service routes', () => {
  test('GET /healthz', async () => {
    const body = expectOk(await get('/healthz'), 200, HealthzSchema);
    expect(body).toEqual({ status: 'ok' });
  });

  test('GET /readyz names the mock model and the fixture references', async () => {
    const body = expectOk(await get('/readyz'), 200, ReadyzSchema);
    expect(body).toEqual({ status: 'ready', checks: { model: 'mock', references: 'fixture' } });
  });

  test('GET /api/v1/config/capabilities', async () => {
    const caps = expectOk(await get('/api/v1/config/capabilities'), 200, CapabilitiesSchema);
    expect(caps).toMatchObject({
      modelProvider: 'mock',
      modelId: null,
      referenceProvider: 'fixture',
      maxImages: 3,
      maxImageBytes: 8 * 1024 * 1024,
      ttlSeconds: 900,
      streaming: { analysisEvents: true },
    });
    const scenarios = expectOk(await get('/api/v1/demo/scenarios'), 200, DemoScenarioListSchema);
    const presets = expectOk(await get('/api/v1/questions/presets'), 200, PresetQuestionsSchema);
    expect(caps.demoScenarios).toEqual(scenarios);
    expect(caps.presets).toEqual(presets);
  });

  test('GET /api/v1/demo/scenarios lists the 8 recorded scenarios', async () => {
    const scenarios = expectOk(await get('/api/v1/demo/scenarios'), 200, DemoScenarioListSchema);
    expect(scenarios.map((s) => s.id)).toEqual(recorded.map((r) => r.args[0].scenarioId));
  });

  test('GET /api/v1/questions/presets', async () => {
    const presets = expectOk(await get('/api/v1/questions/presets'), 200, PresetQuestionsSchema);
    expect(presets.length).toBeGreaterThan(0);
  });
});

const demoIds = new Map<string, string>();
const demoResults = new Map<string, AnalysisResult>();

describe('demo scenarios: Go equals the recorded Node results', () => {
  test('the recording holds the 8 scenarios, with no undefined marker', () => {
    expect(recorded).toHaveLength(8);
    for (const r of recorded) expect(r.fn).toBe('POST /api/v1/demo/scenario');
    expect(JSON.stringify(recorded)).not.toContain('$undefined');
  });

  test.each(recorded.map((r) => [r.args[0].scenarioId, r] as const))(
    '%s',
    async (scenarioId, rec) => {
      const request = DemoScenarioRequestSchema.parse({ scenarioId });
      const created = expectOk(
        await postJSON('/api/v1/demo/scenarios', request),
        202,
        AnalysisCreatedSchema,
      );
      expect(created.id).toMatch(UUID_V4);
      const id = created.id;

      const stream = await events(id);
      const status = expectOk(await get(`/api/v1/analyses/${id}`), 200, AnalysisStatusSchema);
      expect(status).toMatchObject({ id, status: 'completed', isDemo: true });
      expect(status.events).toEqual(stream.map((e) => e.event));
      expect(status.stage).toBe(stream.at(-1)?.event.stage);

      const result = expectOk(
        await get(`/api/v1/analyses/${id}/result`),
        200,
        AnalysisResultSchema,
      );
      expect(withoutIdAndTimes(result, id)).toStrictEqual(rec.result);
      expect(status.stage).toBe(
        result.pipelineState === 'explanation_ready' ? 'completed' : 'needs_attention',
      );

      const refs = expectOk(
        await get(`/api/v1/analyses/${id}/references`),
        200,
        AnalysisReferencesSchema,
      );
      expect(refs).toStrictEqual({
        candidates: result.match.candidates,
        advisories: result.match.advisories,
        limitations: result.match.limitations,
        checkedAt: null,
      });

      demoIds.set(scenarioId, id);
      demoResults.set(scenarioId, result);
    },
  );
});

describe('explanation and speech', () => {
  const s1 = () => demoIds.get('s1-clear') ?? '';
  const explain = (id: string, question: unknown) =>
    postJSON(`/api/v1/analyses/${id}/explanation`, { question });

  test('a printed-strength question is answered from the label', async () => {
    const question = ExplainRequestSchema.parse({ question: 'What strength is printed here?' });
    const answer = expectOk(await explain(s1(), question.question), 200, AnswerSchema);
    expect(answer.status).toBe('answered');
    expect(answer.citedFields).toContain('strength');
  });

  test("s7's dose question is refused, as a result", async () => {
    const scenarios = DemoScenarioListSchema.parse((await get('/api/v1/demo/scenarios')).body);
    const s7 = scenarios.find((s) => s.id === 's7-unsupported-question');
    expect(s7?.presetQuestion).toBeTruthy();
    const id = demoIds.get('s7-unsupported-question') ?? '';
    const answer = expectOk(await explain(id, s7?.presetQuestion), 200, AnswerSchema);
    expect(answer.status).toBe('refused');
  });

  test('an empty question and an unknown analysis are errors', async () => {
    expect(ExplainRequestSchema.safeParse({ question: '' }).success).toBe(false);
    expectError(await explain(s1(), ''), 400, 'VALIDATION_FAILED');
    expectError(await explain(crypto.randomUUID(), 'Who makes this medicine?'), 404, 'NOT_FOUND');
  });

  test('speak: the stored summary, an answer text, and a bad target', async () => {
    const summary = SpeakRequestSchema.parse({ target: 'summary' });
    const speech = expectOk(
      await postJSON(`/api/v1/analyses/${s1()}/speak`, summary),
      200,
      SpeechSchema,
    );
    expect(speech.chunks).toEqual(demoResults.get('s1-clear')?.explanation.spokenChunks);

    const answer = SpeakRequestSchema.parse({ target: 'answer', text: 'The label says 500 mg.' });
    const spoken = expectOk(
      await postJSON(`/api/v1/analyses/${s1()}/speak`, answer),
      200,
      SpeechSchema,
    );
    expect(spoken).toEqual({ language: 'en-US', chunks: ['The label says 500 mg.'] });

    expect(SpeakRequestSchema.safeParse({ target: 'label' }).success).toBe(false);
    expectError(
      await postJSON(`/api/v1/analyses/${s1()}/speak`, { target: 'label' }),
      400,
      'VALIDATION_FAILED',
    );
  });
});

describe('uploads', () => {
  let uploadedId = '';

  test('a sharp photo is accepted, then read by the mock as demo data with provenance', async () => {
    const created = expectOk(
      await upload({ bytes: image('sharp.jpg'), type: 'image/jpeg', name: 'label.jpg' }),
      202,
      AnalysisCreatedSchema,
    );
    uploadedId = created.id;
    expect(uploadedId).toMatch(UUID_V4);

    // asked at once, the result is usually not ready yet: either answer must be in contract
    const early = await get(`/api/v1/analyses/${uploadedId}/result`);
    if (early.status === 409) {
      expectError(early, 409, 'ANALYSIS_NOT_READY');
    } else {
      expectOk(early, 200, AnalysisResultSchema);
    }
    const now = expectOk(await get(`/api/v1/analyses/${uploadedId}`), 200, AnalysisStatusSchema);
    expect(now.isDemo).toBe(true);

    const stream = await events(uploadedId);
    expect(stream.map((e) => e.event.stage)).toEqual([
      'received',
      'quality',
      'reading',
      'reviewing_fields',
      'checking_references',
      'comparing',
      'explaining',
      'completed',
    ]);
    const result = expectOk(
      await get(`/api/v1/analyses/${uploadedId}/result`),
      200,
      AnalysisResultSchema,
    );
    expect(result).toMatchObject({
      isDemo: true,
      pipelineState: 'explanation_ready',
      provenance: { model: 'mock', references: 'fixture' },
    });
    const refs = expectOk(
      await get(`/api/v1/analyses/${uploadedId}/references`),
      200,
      AnalysisReferencesSchema,
    );
    expect(refs.checkedAt).toBeNull();
  });

  test('a blurred photo completes as needs_attention with no label', async () => {
    const created = expectOk(
      await upload({ bytes: image('blurred.jpg'), type: 'image/jpeg', name: 'label.jpg' }),
      202,
      AnalysisCreatedSchema,
    );
    const stream = await events(created.id);
    // the reader is never called; the spoken summary is still built
    expect(stream.map((e) => e.event.stage)).toEqual([
      'received',
      'quality',
      'explaining',
      'needs_attention',
    ]);
    const result = expectOk(
      await get(`/api/v1/analyses/${created.id}/result`),
      200,
      AnalysisResultSchema,
    );
    expect(result).toMatchObject({ pipelineState: 'label_unreadable', label: null });
  });

  test('a photo that cannot be decoded fails the analysis with a stored error', async () => {
    const sharp = image('sharp.jpg');
    const created = expectOk(
      await upload({
        bytes: sharp.subarray(0, sharp.length / 2),
        type: 'image/jpeg',
        name: 'a.jpg',
      }),
      202,
      AnalysisCreatedSchema,
    );
    const stream = await events(created.id);
    expect(stream.at(-1)?.name).toBe('failed');

    const reply = await get(`/api/v1/analyses/${created.id}`);
    const status = expectOk(reply, 200, AnalysisStatusSchema);
    expect(status).toMatchObject({ status: 'failed', stage: 'failed' });
    expect(status.error?.code).toBe('INVALID_IMAGE');
    expect(status.error?.requestId).toBe(reply.headers.get('x-request-id'));
    expect(stream.at(-1)?.event.label).toBe(status.error?.message);

    expectError(await get(`/api/v1/analyses/${created.id}/result`), 415, 'INVALID_IMAGE');
    expectError(
      await postJSON(`/api/v1/analyses/${created.id}/explanation`, { question: 'Who makes it?' }),
      415,
      'INVALID_IMAGE',
    );
  });

  test('a malformed upload is refused synchronously', async () => {
    expectError(
      await upload({
        bytes: new TextEncoder().encode('not an image'),
        type: 'image/jpeg',
        name: 'a.jpg',
      }),
      415,
      'INVALID_IMAGE',
    );
    expectError(
      await call('POST', '/api/v1/analyses', { body: new FormData() }),
      400,
      'VALIDATION_FAILED',
    );
  });

  test('DELETE drops the analysis', async () => {
    const reply = await call('DELETE', `/api/v1/analyses/${uploadedId}`);
    expect(reply.status).toBe(204);
    expect(reply.text).toBe('');
    expectError(await get(`/api/v1/analyses/${uploadedId}/result`), 404, 'NOT_FOUND');
    expectError(await call('DELETE', `/api/v1/analyses/${uploadedId}`), 404, 'NOT_FOUND');
  });
});

describe('errors', () => {
  test('an unknown path and an unknown analysis are 404 NOT_FOUND', async () => {
    expectError(await get('/api/v1/nothing-here'), 404, 'NOT_FOUND');
    const id = crypto.randomUUID();
    for (const path of ['', '/result', '/references', '/events']) {
      expectError(await get(`/api/v1/analyses/${id}${path}`), 404, 'NOT_FOUND');
    }
  });

  test('an id that is not UTF-8 is 400 VALIDATION_FAILED', async () => {
    expectError(await get('/api/v1/analyses/%FF/result'), 400, 'VALIDATION_FAILED');
  });

  test('a bad demo request: unknown scenario, no id, malformed JSON', async () => {
    expectError(
      await postJSON('/api/v1/demo/scenarios', { scenarioId: 's9-none' }),
      404,
      'NOT_FOUND',
    );
    expectError(await postJSON('/api/v1/demo/scenarios', {}), 400, 'VALIDATION_FAILED');
    expectError(
      await call('POST', '/api/v1/demo/scenarios', {
        headers: { 'content-type': 'application/json' },
        body: '{"scenarioId":',
      }),
      400,
      'VALIDATION_FAILED',
    );
  });

  test('no response carried the configured model key', () => {
    expect(bodies.length).toBeGreaterThan(40);
    for (const text of bodies) expect(text).not.toContain(SENTINEL_KEY);
  });

  // last: it spends the rest of this client's write bucket
  test('over the write limit, 429 RATE_LIMITED with Retry-After', async () => {
    let reply: Reply | undefined;
    for (let i = 0; i < 40; i++) {
      reply = await postJSON('/api/v1/demo/scenarios', {});
      if (reply.status === 429) break;
      expectError(reply, 400, 'VALIDATION_FAILED');
    }
    if (reply === undefined) throw new Error('no request sent');
    expectError(reply, 429, 'RATE_LIMITED');
    expect(Number(reply.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
