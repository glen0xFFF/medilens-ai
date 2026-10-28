import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config';
import { ERROR_MESSAGES } from '../../src/http/errors';
import { REDACT_PATHS, createLogger } from '../../src/http/logger';
import { sharpJpeg } from '../helpers/images';
import { expectError, makeApp, stubLive } from './helpers';

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

/* ------------------------------------------------------ final review fixes */

describe('final review I4: per-client rate limit behind a proxy (TRUST_PROXY)', () => {
  async function spend(app: ReturnType<typeof makeApp>['app'], ip: string, n: number) {
    for (let i = 0; i < n; i++) {
      const res = await request(app).get('/api/v1/demo/scenarios').set('X-Forwarded-For', ip);
      expect(res.status).toBe(200);
    }
  }

  test('trusting one proxy hop: each client address has its own 30-request budget', async () => {
    const { app } = makeApp({ trustProxy: 1 });
    await spend(app, '203.0.113.1', 30);
    const a = await request(app)
      .get('/api/v1/demo/scenarios')
      .set('X-Forwarded-For', '203.0.113.1');
    expectError(a, 429, 'RATE_LIMITED');
    const b = await request(app)
      .get('/api/v1/demo/scenarios')
      .set('X-Forwarded-For', '203.0.113.2');
    expect(b.status).toBe(200);
  });

  test('not trusting a proxy (the default outside production): X-Forwarded-For changes nothing', async () => {
    const { app } = makeApp();
    await spend(app, '203.0.113.1', 30);
    const b = await request(app)
      .get('/api/v1/demo/scenarios')
      .set('X-Forwarded-For', '203.0.113.2');
    expectError(b, 429, 'RATE_LIMITED');
  });
});

describe('final review Minor 13: a malformed request is a 400, never a 500', () => {
  test('bad percent-encoding in :id -> 400 VALIDATION_FAILED, no "unhandled error" log', async () => {
    const { app, lines } = makeApp();
    expectError(await request(app).get('/api/v1/labels/%E0%A4%A'), 400, 'VALIDATION_FAILED');
    expectError(await request(app).get('/api/v1/references/%E0%A4%A'), 400, 'VALIDATION_FAILED');
    expectError(
      await request(app).post('/api/v1/labels/%E0%A4%A/explain').send({ question: 'Hi?' }),
      400,
      'VALIDATION_FAILED',
    );
    expect(lines.join('\n')).not.toContain('unhandled error');
  });

  test('a truncated multipart body -> 400 VALIDATION_FAILED, no "unhandled error" log', async () => {
    const { app, lines } = makeApp();
    const res = await request(app)
      .post('/api/v1/labels/analyze')
      .set('Content-Type', 'multipart/form-data; boundary=XYZ')
      .send(
        '--XYZ\r\nContent-Disposition: form-data; name="images"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\nabc',
      );
    expectError(res, 400, 'VALIDATION_FAILED');
    expect(lines.join('\n')).not.toContain('unhandled error');
  });

  test('a multipart body with no boundary -> 400 VALIDATION_FAILED', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/labels/analyze')
      .set('Content-Type', 'multipart/form-data')
      .send('--XYZ\r\n');
    expectError(res, 400, 'VALIDATION_FAILED');
  });

  test('an unexpected error without a 4xx status is still a 500', async () => {
    const { app } = makeApp({
      providerMode: 'live',
      live: stubLive({ reader: { read: () => Promise.reject(new Error('boom')) } }).providers,
    });
    const res = await request(app)
      .post('/api/v1/labels/analyze')
      .attach('images', await sharpJpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    expectError(res, 500, 'INTERNAL_ERROR');
  });
});

describe('final review Minor 16: log lines and CORS origin', () => {
  test('log lines carry no pid or hostname', async () => {
    const { app, lines } = makeApp();
    await request(app).get('/health');
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(entry.msg).toBe('request');
    expect(entry).not.toHaveProperty('pid');
    expect(entry).not.toHaveProperty('hostname');
  });

  test('a CORS_ORIGIN with a trailing slash still matches the browser Origin', async () => {
    const corsOrigin = loadConfig({ CORS_ORIGIN: 'http://localhost:8081/' }).corsOrigin;
    expect(corsOrigin).toBe('http://localhost:8081');
    const { app } = makeApp({ corsOrigin });
    const res = await request(app).get('/health').set('Origin', 'http://localhost:8081');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8081');
  });
});
