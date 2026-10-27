import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { ERROR_MESSAGES } from '../../src/http/errors';
import { REDACT_PATHS, createLogger } from '../../src/http/logger';
import { expectError, makeApp } from './helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('rate limit', () => {
  test('the 31st /api request in a minute -> 429 RATE_LIMITED', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 30; i++) {
      const ok = await request(app).get('/api/v1/demo/scenarios');
      expect(ok.status).toBe(200);
    }
    const res = await request(app).get('/api/v1/demo/scenarios');
    expectError(res, 429, 'RATE_LIMITED');
  });

  test('requests across /api routes share one budget', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 15; i++) await request(app).get('/api/v1/demo/scenarios');
    for (let i = 0; i < 15; i++) await request(app).get('/api/v1/questions/presets');
    expectError(await request(app).get('/api/v1/labels/x'), 429, 'RATE_LIMITED');
  });

  test('/health is not rate limited', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 35; i++) {
      expect((await request(app).get('/health')).status).toBe(200);
    }
  });
});

describe('request ids', () => {
  test('every response carries a fresh UUID X-Request-Id', async () => {
    const { app } = makeApp();
    const a = await request(app).get('/health');
    const b = await request(app).get('/api/v1/labels/nope');
    expect(a.headers['x-request-id']).toMatch(UUID);
    expect(b.headers['x-request-id']).toMatch(UUID);
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
    expect(b.body.error.requestId).toBe(b.headers['x-request-id']);
  });

  test('a client-sent X-Request-Id is not trusted', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/health').set('X-Request-Id', 'client-chosen-id');
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(res.headers['x-request-id']).not.toBe('client-chosen-id');
  });
});

describe('errors', () => {
  test('unknown route -> 404 NOT_FOUND JSON', async () => {
    const { app } = makeApp();
    const api = await request(app).get('/api/v1/nope');
    expectError(api, 404, 'NOT_FOUND');
    expect(api.body.error.message).toBe('Not found.');
    expectError(await request(app).get('/nope'), 404, 'NOT_FOUND');
  });

  test('an expired or unknown result says so and asks for a new scan', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/labels/nope');
    expect(res.body.error.message).toBe(
      'This scan result has expired or does not exist. Please scan again.',
    );
  });

  test('no fixed error message looks like a stack frame', () => {
    for (const message of Object.values(ERROR_MESSAGES)) {
      expect(message).not.toContain('at ');
      expect(message).not.toContain('stack');
    }
  });

  test('no x-powered-by header', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('logs', () => {
  test('one line per request: method, path, status, duration, requestId only', async () => {
    const { app, lines } = makeApp();
    const res = await request(app)
      .post('/api/v1/demo/scenario?token=secret-query')
      .set('Authorization', 'Bearer secret-token')
      .send({ scenarioId: 's1-clear' });
    expect(res.status).toBe(200);
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const entry = entries.find((e) => e.path === '/api/v1/demo/scenario');
    expect(entry).toMatchObject({
      method: 'POST',
      path: '/api/v1/demo/scenario',
      status: 200,
      requestId: res.headers['x-request-id'],
    });
    expect(typeof entry?.durationMs).toBe('number');
    const log = lines.join('\n');
    expect(log).not.toContain('secret-query');
    expect(log).not.toContain('secret-token');
    expect(log).not.toContain('s1-clear');
    expect(log).not.toContain('Paracelin');
  });

  test('redact paths cover authorization, raw text, questions and evidence text', () => {
    expect(REDACT_PATHS).toEqual([
      'req.headers.authorization',
      '*.rawText',
      '*.question',
      '*.evidenceText',
    ]);
    const lines: string[] = [];
    const logger = createLogger({ write: (s: string) => void lines.push(s) });
    logger.info({
      req: { headers: { authorization: 'Bearer k' } },
      label: { rawText: 'RAW-SECRET' },
      body: { question: 'QUESTION-SECRET' },
      field: { evidenceText: 'EVIDENCE-SECRET' },
    });
    const out = lines.join('\n');
    expect(out).not.toContain('Bearer k');
    expect(out).not.toContain('RAW-SECRET');
    expect(out).not.toContain('QUESTION-SECRET');
    expect(out).not.toContain('EVIDENCE-SECRET');
    expect(out).toContain('[Redacted]');
  });
});

describe('CORS', () => {
  test('no CORS headers unless CORS_ORIGIN is set', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/health').set('Origin', 'http://localhost:8081');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('the configured origin is allowed, others are not', async () => {
    const { app } = makeApp({ corsOrigin: 'http://localhost:8081' });
    const ok = await request(app).get('/health').set('Origin', 'http://localhost:8081');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:8081');
    expect(ok.headers['access-control-expose-headers']).toMatch(/X-Request-Id/i);
    const other = await request(app).get('/health').set('Origin', 'https://evil.example.com');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('preflight from the configured origin -> 204', async () => {
    const { app } = makeApp({ corsOrigin: 'http://localhost:8081' });
    const res = await request(app)
      .options('/api/v1/labels/x/explain')
      .set('Origin', 'http://localhost:8081')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
  });
});
