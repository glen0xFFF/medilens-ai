import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { AnalysisResultSchema } from '@medilens/contracts';
import request from 'supertest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSpendMeter } from '../../src/pipeline/budget';
import { blurredJpeg, sharpJpeg, sharpPng } from '../helpers/images';
import { T0, expectError, makeApp, stubLive } from './helpers';

const ANALYZE = '/api/v1/labels/analyze';
const JPEG = { filename: 'label.jpg', contentType: 'image/jpeg' };

/** A JPEG-looking body one megabyte over the 8 MB upload limit. */
function nineMegabytes(): Buffer {
  const buf = Buffer.alloc(9 * 1024 * 1024);
  buf.set([0xff, 0xd8, 0xff, 0xe0]);
  return buf;
}

describe('POST /api/v1/labels/analyze: upload validation', () => {
  test('no file -> 400 VALIDATION_FAILED', async () => {
    const { app } = makeApp();
    expectError(await request(app).post(ANALYZE), 400, 'VALIDATION_FAILED');
  });

  test('a multipart body with only a text field -> 400 VALIDATION_FAILED', async () => {
    const { app } = makeApp();
    const res = await request(app).post(ANALYZE).field('note', 'hello');
    expectError(res, 400, 'VALIDATION_FAILED');
  });

  test('9 MB file -> 413 IMAGE_TOO_LARGE', async () => {
    const { app } = makeApp();
    const res = await request(app).post(ANALYZE).attach('images', nineMegabytes(), JPEG);
    expectError(res, 413, 'IMAGE_TOO_LARGE');
  });

  test('4 files -> 400 VALIDATION_FAILED', async () => {
    const { app } = makeApp();
    const img = await sharpJpeg();
    let req = request(app).post(ANALYZE);
    for (let i = 0; i < 4; i++) req = req.attach('images', img, { ...JPEG, filename: `${i}.jpg` });
    expectError(await req, 400, 'VALIDATION_FAILED');
  });

  test('a file under another field name -> 400 VALIDATION_FAILED', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post(ANALYZE)
      .attach('photo', await sharpJpeg(), JPEG);
    expectError(res, 400, 'VALIDATION_FAILED');
  });

  test('text file -> 415 INVALID_IMAGE', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post(ANALYZE)
      .attach('images', Buffer.from('hello, this is not an image'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      });
    expectError(res, 415, 'INVALID_IMAGE');
  });

  test('text file renamed to .jpg -> 415 INVALID_IMAGE (type comes from the bytes)', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post(ANALYZE)
      .attach('images', Buffer.from('hello, this is not an image'), JPEG);
    expectError(res, 415, 'INVALID_IMAGE');
  });

  test('truncated JPEG -> 415 INVALID_IMAGE', async () => {
    const { app } = makeApp();
    const img = await sharpJpeg();
    const res = await request(app).post(ANALYZE).attach('images', img.subarray(0, 600), JPEG);
    expectError(res, 415, 'INVALID_IMAGE');
  });

  test('one bad image among good ones fails the whole upload', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post(ANALYZE)
      .attach('images', await sharpJpeg(), JPEG)
      .attach('images', Buffer.from('not an image'), {
        filename: 'b.txt',
        contentType: 'text/plain',
      });
    expectError(res, 415, 'INVALID_IMAGE');
  });
});

describe('POST /api/v1/labels/analyze in demo mode', () => {
  test('a real upload is read with the s1 fixture and marked isDemo', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post(ANALYZE)
      .attach('images', await sharpJpeg(), JPEG);
    expect(res.status).toBe(200);
    expect(AnalysisResultSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.isDemo).toBe(true);
    expect(res.body.match.status).toBe('verified');
    expect(res.body.pipelineState).toBe('explanation_ready');
    expect(res.body.explanation.spokenChunks[0]).toMatch(/^Demo data\./);
    expect(res.body.imageRetention).toBe('none');
  });

  test('up to three images of different sides are accepted', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post(ANALYZE)
      .attach('images', await sharpJpeg(), JPEG)
      .attach('images', await sharpPng(), { filename: 'b.png', contentType: 'image/png' })
      .attach('images', await sharpJpeg(), { ...JPEG, filename: 'c.jpg' });
    expect(res.status).toBe(200);
    expect(res.body.isDemo).toBe(true);
  });

  test('a blurry photo still fails the real quality check: label_unreadable, no label', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post(ANALYZE)
      .attach('images', await blurredJpeg(), JPEG);
    expect(res.status).toBe(200);
    expect(res.body.pipelineState).toBe('label_unreadable');
    expect(res.body.label).toBeNull();
    expect(res.body.quality.reasons).toContain('BLURRY');
    expect(res.body.isDemo).toBe(true);
  });

  test('the result is stored for follow-up calls', async () => {
    const { app } = makeApp();
    const created = await request(app)
      .post(ANALYZE)
      .attach('images', await sharpJpeg(), JPEG);
    const res = await request(app).get(`/api/v1/labels/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
  });
});

describe('POST /api/v1/labels/analyze in live mode', () => {
  test('uses the live providers and is not marked isDemo', async () => {
    const stub = stubLive();
    const { app } = makeApp({ providerMode: 'live', live: stub.providers });
    const res = await request(app)
      .post(ANALYZE)
      .attach('images', await sharpJpeg(), JPEG);
    expect(res.status).toBe(200);
    expect(AnalysisResultSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.isDemo).toBe(false);
    expect(res.body.explanation.spokenChunks[0]).not.toMatch(/^Demo data/);
    expect(stub.calls.read).toBe(1);
    expect(stub.calls.search).toBe(1);
  });

  test('budget exhausted -> 503 LIVE_BUDGET_EXHAUSTED before the model, while demo still works', async () => {
    const stub = stubLive();
    const meter = createSpendMeter(5, () => T0);
    meter.record({ prompt_tokens: 4_000_000, completion_tokens: 0 });
    const { app } = makeApp({ providerMode: 'live', live: stub.providers, meter });
    const res = await request(app)
      .post(ANALYZE)
      .attach('images', await sharpJpeg(), JPEG);
    expectError(res, 503, 'LIVE_BUDGET_EXHAUSTED');
    expect(res.body.error.message).toMatch(/demo mode/i);
    expect(stub.calls.read).toBe(0);

    const demo = await request(app).post('/api/v1/demo/scenario').send({ scenarioId: 's1-clear' });
    expect(demo.status).toBe(200);
  });

  test('reader failure -> 502 OCR_FAILED', async () => {
    const stub = stubLive({
      reader: {
        read: () => Promise.resolve({ ok: false, code: 'OCR_FAILED', detail: 'invalid_output' }),
      },
    });
    const { app } = makeApp({ providerMode: 'live', live: stub.providers });
    const res = await request(app)
      .post(ANALYZE)
      .attach('images', await sharpJpeg(), JPEG);
    expectError(res, 502, 'OCR_FAILED');
    expect(res.text).not.toContain('invalid_output');
  });

  test('an unexpected throw -> 500 INTERNAL_ERROR with a generic message and no stack', async () => {
    const stub = stubLive({
      reader: { read: () => Promise.reject(new Error('boom: secret detail at reader')) },
    });
    const { app, lines } = makeApp({ providerMode: 'live', live: stub.providers });
    const res = await request(app)
      .post(ANALYZE)
      .attach('images', await sharpJpeg(), JPEG);
    expectError(res, 500, 'INTERNAL_ERROR');
    expect(res.text).not.toContain('boom');
    expect(res.text).not.toContain('secret detail');
    expect(lines.join('\n')).not.toContain('secret detail');
  });
});

describe('no image is written to disk', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  test.each(['demo', 'live'] as const)('%s mode analyze never writes a file', async (mode) => {
    const spies = [
      vi.spyOn(fs, 'writeFile'),
      vi.spyOn(fs, 'writeFileSync'),
      vi.spyOn(fs, 'createWriteStream'),
      vi.spyOn(fs, 'appendFile'),
      vi.spyOn(fs, 'appendFileSync'),
      vi.spyOn(fs.promises, 'writeFile'),
      vi.spyOn(fs.promises, 'appendFile'),
    ];
    // make ESM named imports of node:fs see the spies too
    syncBuiltinESMExports();
    const stub = stubLive();
    const { app } = makeApp(mode === 'live' ? { providerMode: 'live', live: stub.providers } : {});
    const res = await request(app)
      .post(ANALYZE)
      .attach('images', await sharpJpeg(), JPEG)
      .attach('images', await sharpPng(), { filename: 'b.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
