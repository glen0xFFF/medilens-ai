import {
  AnalysisResultSchema,
  DemoScenarioSummarySchema,
  ReferenceRecordSchema,
  type MatchStatus,
  type PipelineState,
} from '@medilens/contracts';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { ALLOWED_QUESTION_EXAMPLES } from '../../src/domain/safety';
import { mentionsFake } from '../../src/pipeline/explain';
import { createSpendMeter } from '../../src/pipeline/budget';
import { sharpJpeg } from '../helpers/images';
import { SCENARIO_IDS, T0, expectError, makeApp, stubLive } from './helpers';

const EXPECTED: Record<
  (typeof SCENARIO_IDS)[number],
  { status: MatchStatus; pipelineState: PipelineState }
> = {
  's1-clear': { status: 'verified', pipelineState: 'explanation_ready' },
  's2-blurry': { status: 'not_attempted', pipelineState: 'label_unreadable' },
  's3-similar': { status: 'ambiguous', pipelineState: 'explanation_ready' },
  's4-conflict': { status: 'conflicting', pipelineState: 'explanation_ready' },
  's5-nomatch': { status: 'no_match', pipelineState: 'explanation_ready' },
  's6-loose-pill': { status: 'not_attempted', pipelineState: 'loose_pill' },
  's7-unsupported-question': { status: 'verified', pipelineState: 'explanation_ready' },
  's8-registry-down': { status: 'unavailable', pipelineState: 'explanation_ready' },
};

describe('GET /health', () => {
  test('200 {status: ok, providerMode: demo} with a version', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', providerMode: 'demo' });
    expect(typeof res.body.version).toBe('string');
  });

  test('reports live mode', async () => {
    const { app } = makeApp({ providerMode: 'live', live: stubLive().providers });
    const res = await request(app).get('/health');
    expect(res.body).toMatchObject({ status: 'ok', providerMode: 'live' });
  });
});

describe('GET /api/v1/demo/scenarios', () => {
  test('lists the eight scenario ids and titles, each labelled DEMO DATA', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/demo/scenarios');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map((s: { id: string }) => s.id)).toEqual([...SCENARIO_IDS]);
    for (const s of res.body) {
      expect(DemoScenarioSummarySchema.strict().safeParse(s).success).toBe(true);
      expect(s.title).toMatch(/^DEMO DATA/);
    }
  });
});

describe('GET /api/v1/questions/presets', () => {
  test('returns the allowed preset questions for the app buttons', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/questions/presets');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(ALLOWED_QUESTION_EXAMPLES);
  });
});

describe.each(['demo', 'live'] as const)('POST /api/v1/demo/scenario in %s mode', (mode) => {
  function setup() {
    const stub = stubLive();
    // live mode with an exhausted budget: demo scenarios never spend
    const meter = createSpendMeter(0, () => T0);
    const made = makeApp(
      mode === 'live' ? { providerMode: 'live', live: stub.providers, meter } : {},
    );
    return { ...made, calls: stub.calls };
  }

  test.each(SCENARIO_IDS)(
    '%s: 200 with the expected status and state, isDemo true, fixtures only',
    async (id) => {
      const { app, calls } = setup();
      const res = await request(app).post('/api/v1/demo/scenario').send({ scenarioId: id });
      expect(res.status).toBe(200);
      const parsed = AnalysisResultSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(res.body.isDemo).toBe(true);
      expect(res.body.imageRetention).toBe('none');
      expect(res.body.match.status).toBe(EXPECTED[id].status);
      expect(res.body.pipelineState).toBe(EXPECTED[id].pipelineState);
      expect(calls).toMatchObject({ read: 0, search: 0, answer: 0 });
    },
  );

  test('the stored result is retrievable by id', async () => {
    const { app } = setup();
    const created = await request(app)
      .post('/api/v1/demo/scenario')
      .send({ scenarioId: 's1-clear' });
    const res = await request(app).get(`/api/v1/labels/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
  });

  test('unknown scenario id -> 404 NOT_FOUND', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/v1/demo/scenario').send({ scenarioId: 's9-nope' });
    expectError(res, 404, 'NOT_FOUND');
    expect(res.body.error.message).toBe('Unknown demo scenario.');
  });

  test.each([{}, { scenarioId: '' }, { scenarioId: 7 }, []])(
    'invalid body %o -> 400 VALIDATION_FAILED',
    async (body) => {
      const { app } = setup();
      const res = await request(app).post('/api/v1/demo/scenario').send(body);
      expectError(res, 400, 'VALIDATION_FAILED');
    },
  );

  test('malformed JSON -> 400 VALIDATION_FAILED', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/api/v1/demo/scenario')
      .set('Content-Type', 'application/json')
      .send('{"scenarioId": ');
    expectError(res, 400, 'VALIDATION_FAILED');
  });

  test('a JSON body over 16 kB -> 400 VALIDATION_FAILED', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/api/v1/demo/scenario')
      .send({ scenarioId: 's1-clear', pad: 'x'.repeat(17 * 1024) });
    expectError(res, 400, 'VALIDATION_FAILED');
  });
});

describe('fake / counterfeit wording', () => {
  test('no scenario response says fake or counterfeit outside the fixed sentences', async () => {
    const { app } = makeApp();
    for (const id of SCENARIO_IDS) {
      const res = await request(app).post('/api/v1/demo/scenario').send({ scenarioId: id });
      expect(res.status).toBe(200);
      expect(mentionsFake(res.text)).toBe(false);
    }
  });
});

describe('GET /api/v1/references/:id', () => {
  /** A live scan (stub providers, s1 fixture data) whose registry returns `records`. */
  async function liveScan(records: 'fixture' | 'none') {
    const stub = stubLive(
      records === 'none'
        ? {
            references: {
              search: () => Promise.resolve({ kind: 'ok', records: [], advisories: [] }),
            },
          }
        : {},
    );
    const { app } = makeApp({ providerMode: 'live', live: stub.providers });
    const created = await request(app)
      .post('/api/v1/labels/analyze')
      .attach('images', await sharpJpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(created.status).toBe(200);
    expect(created.body.isDemo).toBe(false);
    return { app, created };
  }

  test('live: candidates, advisories, limitations and checkedAt from the stored result', async () => {
    const { app, created } = await liveScan('fixture');
    const res = await request(app).get(`/api/v1/references/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['advisories', 'candidates', 'checkedAt', 'limitations'].sort(),
    );
    expect(res.body.candidates).toEqual(created.body.match.candidates);
    expect(res.body.advisories).toEqual(created.body.match.advisories);
    expect(res.body.limitations).toEqual(created.body.match.limitations);
    expect(res.body.checkedAt).toBe(created.body.match.candidates[0].checkedAt);
  });

  test('live: no candidates, checkedAt is when the analysis ran', async () => {
    const { app, created } = await liveScan('none');
    const res = await request(app).get(`/api/v1/references/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual([]);
    expect(res.body.checkedAt).toBe(created.body.createdAt);
  });

  // final review Minor 18: no registry was checked for made-up demo data
  test.each(SCENARIO_IDS)('%s demo result: checkedAt is null', async (id) => {
    const { app } = makeApp();
    const created = await request(app).post('/api/v1/demo/scenario').send({ scenarioId: id });
    const res = await request(app).get(`/api/v1/references/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.checkedAt).toBeNull();
    expect(res.body.candidates).toEqual(created.body.match.candidates);
    for (const c of res.body.candidates as { sourceUrl: string }[]) {
      expect(c.sourceUrl.startsWith('https://example.org/medilens-demo/')).toBe(true);
      expect(ReferenceRecordSchema.safeParse(c).success).toBe(true);
    }
  });

  test('a demo upload (demo mode reads it as s1): checkedAt is null', async () => {
    const { app } = makeApp();
    const created = await request(app)
      .post('/api/v1/labels/analyze')
      .attach('images', await sharpJpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(created.body.isDemo).toBe(true);
    const res = await request(app).get(`/api/v1/references/${created.body.id}`);
    expect(res.body.checkedAt).toBeNull();
  });

  test.each(['s2-blurry', 's8-registry-down'])(
    '%s: registry not checked or unavailable -> checkedAt null',
    async (id) => {
      const { app } = makeApp();
      const created = await request(app).post('/api/v1/demo/scenario').send({ scenarioId: id });
      const res = await request(app).get(`/api/v1/references/${created.body.id}`);
      expect(res.status).toBe(200);
      expect(res.body.checkedAt).toBeNull();
      expect(res.body.limitations).toEqual(created.body.match.limitations);
    },
  );

  test('unknown id -> 404 NOT_FOUND', async () => {
    const { app } = makeApp();
    expectError(await request(app).get('/api/v1/references/nope'), 404, 'NOT_FOUND');
  });
});

describe('GET /api/v1/labels/:id', () => {
  test('unknown id -> 404 NOT_FOUND', async () => {
    const { app } = makeApp();
    expectError(await request(app).get('/api/v1/labels/nope'), 404, 'NOT_FOUND');
  });

  test('404 NOT_FOUND after the 15 minute TTL', async () => {
    let t = T0;
    const { app } = makeApp({ now: () => t });
    const created = await request(app)
      .post('/api/v1/demo/scenario')
      .send({ scenarioId: 's1-clear' });
    t = T0 + 15 * 60 * 1000;
    expectError(await request(app).get(`/api/v1/labels/${created.body.id}`), 404, 'NOT_FOUND');
  });
});
