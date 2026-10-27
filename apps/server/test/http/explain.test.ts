import { AnswerSchema, type Answer } from '@medilens/contracts';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { getScenario } from '../../src/demo/scenarios';
import { ANSWER_FALLBACK_TEXT, PHRASE_NOT_FOUND_TEXT } from '../../src/domain/answers';
import { ALLOWED_QUESTION_EXAMPLES, REFUSAL_TEXT } from '../../src/domain/safety';
import { ADVISORY_SENTENCE, FINAL_LINE, STATUS_SENTENCE } from '../../src/domain/summary';
import { createSpendMeter } from '../../src/pipeline/budget';
import { NO_LABEL_TEXT, mentionsFake } from '../../src/pipeline/explain';
import type { QuestionAnswerer } from '../../src/providers/types';
import { sharpJpeg } from '../helpers/images';
import { T0, expectError, makeApp, stubLive, type TestAppOptions } from './helpers';

type App = ReturnType<typeof makeApp>['app'];

async function scenarioResult(app: App, scenarioId: string) {
  const res = await request(app).post('/api/v1/demo/scenario').send({ scenarioId });
  expect(res.status).toBe(200);
  return res.body;
}

async function liveResult(app: App) {
  const res = await request(app)
    .post('/api/v1/labels/analyze')
    .attach('images', await sharpJpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
  expect(res.status).toBe(200);
  expect(res.body.isDemo).toBe(false);
  return res.body;
}

function ask(app: App, id: string, question: unknown) {
  return request(app).post(`/api/v1/labels/${id}/explain`).send({ question });
}

function expectAnswer(body: unknown): Answer {
  const parsed = AnswerSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  return body as Answer;
}

function liveApp(answerer?: QuestionAnswerer, extra: TestAppOptions = {}) {
  const stub = stubLive(answerer === undefined ? {} : { answerer });
  return {
    ...makeApp({ providerMode: 'live', live: stub.providers, ...extra }),
    calls: stub.calls,
  };
}

describe('POST /api/v1/labels/:id/explain: safety gate first', () => {
  test('s7 preset question -> refused with the pharmacist redirect', async () => {
    const { app } = makeApp();
    const s7 = getScenario('s7-unsupported-question');
    const r = await scenarioResult(app, 's7-unsupported-question');
    const res = await ask(app, r.id, s7?.presetQuestion);
    expect(res.status).toBe(200);
    const a = expectAnswer(res.body);
    expect(a).toEqual({
      status: 'refused',
      text: REFUSAL_TEXT.personal_dose,
      spokenChunks: [REFUSAL_TEXT.personal_dose],
      citedFields: [],
      safetyNotice: REFUSAL_TEXT.personal_dose,
    });
  });

  test('a possible overdose gets the emergency text even on an unreadable scan', async () => {
    const { app } = makeApp();
    const r = await scenarioResult(app, 's2-blurry');
    const res = await ask(app, r.id, 'My child swallowed the whole bottle');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('refused');
    expect(res.body.text).toBe(REFUSAL_TEXT.possible_overdose);
  });

  test('a free-typed question outside the label is refused (default deny)', async () => {
    const { app } = makeApp();
    const r = await scenarioResult(app, 's1-clear');
    const res = await ask(app, r.id, 'Tell me a joke about pharmacists');
    expect(res.body.status).toBe('refused');
    expect(res.body.text).toBe(REFUSAL_TEXT.outside_label);
  });

  test('a refused question never reaches the live answerer', async () => {
    const { app, calls } = liveApp();
    const r = await liveResult(app);
    const res = await ask(app, r.id, 'How many should I take for my headache?');
    expect(res.body.status).toBe('refused');
    expect(calls.answer).toBe(0);
  });
});

describe('POST /api/v1/labels/:id/explain: answers', () => {
  test('s1 allowed question -> answered with cited fields', async () => {
    const { app } = makeApp();
    const r = await scenarioResult(app, 's1-clear');
    const res = await ask(app, r.id, 'What strength is printed here?');
    expect(res.status).toBe(200);
    const a = expectAnswer(res.body);
    expect(a.status).toBe('answered');
    expect(a.citedFields).toEqual(['strength']);
    expect(a.text).toContain('500 mg');
    expect(a.spokenChunks.at(-1)).toBe(FINAL_LINE);
  });

  test.each(ALLOWED_QUESTION_EXAMPLES)('s1 preset "%s" is answered, never refused', async (q) => {
    const { app } = makeApp();
    const r = await scenarioResult(app, 's1-clear');
    const res = await ask(app, r.id, q);
    expect(res.status).toBe(200);
    const a = expectAnswer(res.body);
    expect(a.status).not.toBe('refused');
  });

  test('"Can you repeat that?" replays the stored summary without any answerer', async () => {
    const { app, calls } = liveApp();
    const r = await liveResult(app);
    const res = await ask(app, r.id, 'Can you repeat that?');
    const a = expectAnswer(res.body);
    expect(a.status).toBe('answered');
    expect(a.text).toBe(r.explanation.displayText);
    expect(a.spokenChunks).toEqual(r.explanation.spokenChunks);
    expect(calls.answer).toBe(0);
  });

  test('repeat works on an unreadable scan too (replays the retake prompt)', async () => {
    const { app } = makeApp();
    const r = await scenarioResult(app, 's2-blurry');
    const res = await ask(app, r.id, 'Can you repeat that?');
    expect(res.body.status).toBe('answered');
    expect(res.body.spokenChunks).toEqual(r.explanation.spokenChunks);
  });

  test('no label was read -> unclear, nothing cited', async () => {
    const { app } = makeApp();
    const r = await scenarioResult(app, 's2-blurry');
    expect(r.label).toBeNull();
    const res = await ask(app, r.id, 'What strength is printed here?');
    const a = expectAnswer(res.body);
    expect(a.status).toBe('unclear');
    expect(a.text).toBe(NO_LABEL_TEXT);
    expect(NO_LABEL_TEXT).toBe("I couldn't read this label, so I can't answer questions about it.");
    expect(a.citedFields).toEqual([]);
  });

  test('s5 registry answer keeps the fixed "does not mean the product is fake" sentence', async () => {
    const { app } = makeApp();
    const r = await scenarioResult(app, 's5-nomatch');
    const res = await ask(app, r.id, 'What did the FDA registry say?');
    const a = expectAnswer(res.body);
    expect(a.status).toBe('answered');
    expect(a.text).toContain(STATUS_SENTENCE.no_match);
  });

  test('a live registry answer keeps the fixed advisory sentence', async () => {
    const s1 = getScenario('s1-clear');
    const stub = stubLive({
      references: {
        search: () =>
          Promise.resolve({
            kind: 'ok',
            records: s1?.reference.kind === 'ok' ? structuredClone(s1.reference.records) : [],
            advisories: [
              { title: 'DEMO DATA advisory', url: 'https://www.fda.gov.ph/demo-advisory' },
            ],
          }),
      },
    });
    const { app } = makeApp({ providerMode: 'live', live: stub.providers });
    const r = await liveResult(app);
    const res = await ask(app, r.id, 'What did the FDA registry say?');
    const a = expectAnswer(res.body);
    expect(a.status).toBe('answered');
    expect(a.text).toContain(ADVISORY_SENTENCE);
  });
});

describe('POST /api/v1/labels/:id/explain: answerer routing', () => {
  test('a live result is answered by the live answerer', async () => {
    const { app, calls } = liveApp();
    const r = await liveResult(app);
    const res = await ask(app, r.id, 'What strength is printed here?');
    expect(res.body.status).toBe('answered');
    expect(calls.answer).toBe(1);
    expect(calls.answerInputs[0]).toMatchObject({
      intent: 'strength',
      question: 'What strength is printed here?',
    });
    expect(calls.answerInputs[0]?.label).toEqual(r.label);
    expect(calls.answerInputs[0]?.match).toEqual(r.match);
  });

  test('a demo result in live mode is answered by the fixture answerer', async () => {
    const { app, calls } = liveApp();
    const r = await scenarioResult(app, 's1-clear');
    const res = await ask(app, r.id, 'What strength is printed here?');
    expect(res.body.status).toBe('answered');
    expect(calls.answer).toBe(0);
  });
});

describe('POST /api/v1/labels/:id/explain: grounding (same in demo and live)', () => {
  const Q = 'What does "xyzzy tincture" mean?';

  test('demo: a phrase not printed on the label -> unclear', async () => {
    const { app } = makeApp();
    const r = await scenarioResult(app, 's1-clear');
    const a = expectAnswer((await ask(app, r.id, Q)).body);
    expect(a.status).toBe('unclear');
    expect(a.text).toBe(PHRASE_NOT_FOUND_TEXT);
  });

  test('live: a phrase not printed on the label -> unclear, the answerer is never called', async () => {
    const { app, calls } = liveApp({
      answer: () =>
        Promise.resolve({
          status: 'answered',
          text: 'Xyzzy tincture is a herbal remedy.',
          spokenChunks: ['Xyzzy tincture is a herbal remedy.'],
          citedFields: ['warnings'],
          safetyNotice: null,
        }),
    });
    const r = await liveResult(app);
    const a = expectAnswer((await ask(app, r.id, Q)).body);
    expect(a.status).toBe('unclear');
    expect(a.text).toBe(PHRASE_NOT_FOUND_TEXT);
    expect(calls.answer).toBe(0);
  });

  test('demo: a printed phrase is quoted from the label', async () => {
    const { app } = makeApp();
    const r = await scenarioResult(app, 's1-clear');
    const a = expectAnswer((await ask(app, r.id, 'What does "dry place" mean?')).body);
    expect(a.status).toBe('answered');
    expect(a.text).toContain('dry place');
  });

  test('live: a printed phrase passes the check and reaches the answerer', async () => {
    const { app, calls } = liveApp();
    const r = await liveResult(app);
    await ask(app, r.id, 'What does "dry place" mean?');
    expect(calls.answer).toBe(1);
    expect(calls.answerInputs[0]?.intent).toBe('explain_text');
  });
});

describe('POST /api/v1/labels/:id/explain: never "fake" or "counterfeit"', () => {
  const ATTEMPTS: [string, Answer][] = [
    [
      'in the text',
      {
        status: 'answered',
        text: 'This pack is counterfeit.',
        spokenChunks: ['This pack is counterfeit.', FINAL_LINE],
        citedFields: ['brandName'],
        safetyNotice: null,
      },
    ],
    [
      'only in a spoken chunk',
      {
        status: 'answered',
        text: 'Strength as printed: 500 mg.',
        spokenChunks: ['Strength as printed: 500 mg.', 'It may be FAKE.', FINAL_LINE],
        citedFields: ['strength'],
        safetyNotice: null,
      },
    ],
    [
      'only in the safety notice',
      {
        status: 'answered',
        text: 'Strength as printed: 500 mg.',
        spokenChunks: ['Strength as printed: 500 mg.', FINAL_LINE],
        citedFields: ['strength'],
        safetyNotice: 'Watch out for fakes.',
      },
    ],
    [
      'next to the fixed advisory sentence',
      {
        status: 'answered',
        text: `${ADVISORY_SENTENCE} Yours looks counterfeit.`,
        spokenChunks: [ADVISORY_SENTENCE, 'Yours looks counterfeit.', FINAL_LINE],
        citedFields: ['brandName'],
        safetyNotice: ADVISORY_SENTENCE,
      },
    ],
  ];

  test.each(ATTEMPTS)(
    'a stub answerer that says it %s is replaced by the fixed fallback',
    async (_label, bad) => {
      const { app } = liveApp({ answer: () => Promise.resolve(bad) });
      const r = await liveResult(app);
      const res = await ask(app, r.id, 'What strength is printed here?');
      expect(res.status).toBe(200);
      const a = expectAnswer(res.body);
      expect(a.status).toBe('unclear');
      expect(a.text).toBe(ANSWER_FALLBACK_TEXT);
      expect(a.citedFields).toEqual([]);
      expect(res.text).not.toMatch(/fake|counterfeit/i);
    },
  );

  test('mentionsFake allows only the fixed sentences', () => {
    expect(mentionsFake(ADVISORY_SENTENCE)).toBe(false);
    expect(mentionsFake(STATUS_SENTENCE.no_match)).toBe(false);
    expect(mentionsFake('This does not mean the product is fake.')).toBe(false);
    expect(mentionsFake('The product is fake.')).toBe(true);
    expect(mentionsFake('COUNTERFEIT')).toBe(true);
    expect(mentionsFake('fakes')).toBe(true);
    expect(mentionsFake(`${STATUS_SENTENCE.no_match} But it is fake.`)).toBe(true);
  });
});

describe('POST /api/v1/labels/:id/explain: budget', () => {
  function exhaustedLiveApp() {
    const meter = createSpendMeter(5, () => T0);
    const made = liveApp(undefined, { meter });
    return { ...made, meter };
  }

  test('live result + exhausted budget -> 503 LIVE_BUDGET_EXHAUSTED, answerer not called', async () => {
    const { app, calls, meter } = exhaustedLiveApp();
    const r = await liveResult(app);
    meter.record({ prompt_tokens: 0, completion_tokens: 2_000_000 });
    const res = await ask(app, r.id, 'What strength is printed here?');
    expectError(res, 503, 'LIVE_BUDGET_EXHAUSTED');
    expect(calls.answer).toBe(0);
  });

  test('refusals and repeats still work with the budget exhausted', async () => {
    const { app, meter } = exhaustedLiveApp();
    const r = await liveResult(app);
    meter.record({ prompt_tokens: 0, completion_tokens: 2_000_000 });
    expect((await ask(app, r.id, 'My child swallowed the whole bottle')).body.text).toBe(
      REFUSAL_TEXT.possible_overdose,
    );
    expect((await ask(app, r.id, 'Can you repeat that?')).body.status).toBe('answered');
  });

  test('a demo result is answered with the budget exhausted', async () => {
    const { app, meter } = exhaustedLiveApp();
    meter.record({ prompt_tokens: 0, completion_tokens: 2_000_000 });
    const r = await scenarioResult(app, 's1-clear');
    const res = await ask(app, r.id, 'What strength is printed here?');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('answered');
  });
});

describe('POST /api/v1/labels/:id/explain: validation and errors', () => {
  test('unknown id -> 404 NOT_FOUND', async () => {
    const { app } = makeApp();
    expectError(await ask(app, 'no-such-id', 'What strength is printed here?'), 404, 'NOT_FOUND');
  });

  test.each([undefined, '', '   ', 5, 'x'.repeat(301)])(
    'question %o -> 400 VALIDATION_FAILED',
    async (question) => {
      const { app } = makeApp();
      const r = await scenarioResult(app, 's1-clear');
      expectError(await ask(app, r.id, question), 400, 'VALIDATION_FAILED');
    },
  );

  test('a malformed answer from an answerer -> 500 INTERNAL_ERROR', async () => {
    const { app } = liveApp({
      answer: () => Promise.resolve({ status: 'maybe' } as unknown as Answer),
    });
    const r = await liveResult(app);
    expectError(await ask(app, r.id, 'What strength is printed here?'), 500, 'INTERNAL_ERROR');
  });

  test('the question text never reaches the logs', async () => {
    const { app, lines } = makeApp();
    const r = await scenarioResult(app, 's1-clear');
    await ask(app, r.id, 'What does "dry place" mean?');
    await ask(app, r.id, 'My grandmother Rosalinda took two tablets');
    const log = lines.join('\n');
    expect(log).toContain('/explain');
    expect(log).not.toContain('dry place');
    expect(log).not.toContain('Rosalinda');
  });
});
