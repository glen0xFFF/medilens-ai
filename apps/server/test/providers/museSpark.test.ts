import { readFileSync } from 'node:fs';
import {
  AnswerSchema,
  ExtractedLabelSchema,
  type ExtractedLabel,
  type FieldKey,
  type LabelField,
  type MatchAssessment,
} from '@medilens/contracts';
import { describe, expect, test } from 'vitest';
import { ADVISORY_SENTENCE, FINAL_LINE } from '../../src/domain/summary';
import {
  ANSWER_FALLBACK_TEXT,
  ANSWER_UNCERTAIN_SENTENCE,
  MUSE_MODEL,
  PHRASE_NOT_FOUND_TEXT,
  createMetaClient,
  createMuseSparkAnswerer,
  createMuseSparkLabelReader,
  type ChatClient,
  type ModelUsage,
} from '../../src/providers/museSpark';
import type { AnswerInput } from '../../src/providers/types';

/* Synthetic recorded completions (DEMO DATA, fictional product). No network. */
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/muse/${name}.json`, import.meta.url), 'utf8'),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

function fakeClient(...responses: (unknown | Error)[]) {
  const calls: Body[] = [];
  const client = {
    create: (body: Body) => {
      calls.push(body);
      const next = responses.shift();
      if (next === undefined) return Promise.reject(new Error('fake client: no response queued'));
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
  } as unknown as ChatClient;
  return { client, calls };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const JPEG2 = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x01, 0x02, 0x03]);
const CTX = {};

const KEYS: FieldKey[] = [
  'brandName',
  'genericNames',
  'strength',
  'dosageForm',
  'manufacturer',
  'registrationNumber',
  'directions',
  'warnings',
  'storage',
  'expiryDate',
  'batchNumber',
  'rxOrOtc',
];

describe('createMetaClient', () => {
  test('builds a chat completions client without any network call', () => {
    const client = createMetaClient('test-key-not-real');
    expect(typeof client.create).toBe('function');
  });
});

describe('createMuseSparkLabelReader', () => {
  test('maps a valid completion to an ExtractedLabel', async () => {
    const { client, calls } = fakeClient(fixture('label-ok'));
    const r = await createMuseSparkLabelReader(client).read([JPEG], CTX);
    expect(calls).toHaveLength(1);
    if (!r.ok) throw new Error(`expected ok, got ${r.detail}`);
    expect(r.model).toBe('muse-spark-1.3');
    expect(ExtractedLabelSchema.safeParse(r.label).success).toBe(true);
    expect(r.label.imageKind).toBe('label');
    expect(r.label.fields.map((f) => f.key)).toEqual(KEYS);
    const field = (k: FieldKey) => r.label.fields.find((f) => f.key === k) as LabelField;
    expect(field('brandName')).toEqual({
      key: 'brandName',
      value: 'Paracelin 500',
      legibility: 'clear',
      evidenceText: 'Paracelin 500',
      imageIndex: null,
      notes: null,
    });
    expect(field('strength').legibility).toBe('partial');
    expect(field('strength').notes).toBe('Second digit partly covered by glare.');
    expect(field('rxOrOtc').value).toBeNull();
    // an empty transcription is absence, not a value
    expect(field('batchNumber').value).toBeNull();
    expect(r.label.rawText).toContain('DEMO DATA Paracelin 500');
    expect(r.label.warnings).toEqual(['Strength partly obscured by glare.']);
  });

  test('sends the fixed model, effort, token cap and strict json_schema', async () => {
    const { client, calls } = fakeClient(fixture('label-ok'));
    await createMuseSparkLabelReader(client).read([JPEG], CTX);
    const body = calls[0] as Body;
    expect(MUSE_MODEL).toBe('muse-spark-1.3');
    expect(body.model).toBe('muse-spark-1.3');
    expect(body.reasoning_effort).toBe('low');
    expect(body.max_tokens).toBe(4000);
    expect(body.stream).toBeFalsy();
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('medicine_label');
    expect(body.response_format.json_schema.strict).toBe(true);
    const schema = body.response_format.json_schema.schema;
    const text = JSON.stringify(schema);
    expect(text).not.toContain('$ref');
    expect(text).not.toContain('$defs');
    expect(text).not.toContain('anyOf');
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(
      ['fields', 'imageKind', 'rawText', 'warnings'].sort(),
    );
    expect(schema.properties.imageKind.enum).toEqual([
      'label',
      'loose_pill',
      'not_medicine',
      'unreadable',
    ]);
    const fields = schema.properties.fields;
    expect([...fields.required].sort()).toEqual([...KEYS].sort());
    expect(fields.additionalProperties).toBe(false);
    const brand = fields.properties.brandName;
    expect(brand.properties.value.type).toEqual(['string', 'null']);
    expect(brand.additionalProperties).toBe(false);
    expect([...brand.required].sort()).toEqual(['evidenceText', 'legibility', 'notes', 'value']);
  });

  test('sends a transcribe-only system prompt and the image as a JPEG data URL', async () => {
    const { client, calls } = fakeClient(fixture('label-ok'));
    await createMuseSparkLabelReader(client).read([JPEG], CTX);
    const messages = (calls[0] as Body).messages as Body[];
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content).toMatch(/transcribe/i);
    expect(system?.content).toMatch(/never (?:guess|infer)/i);
    expect(system?.content).toMatch(/loose_pill/);
    expect(system?.content).toMatch(/not_medicine/);
    const user = messages.find((m) => m.role === 'user') as Body;
    const images = (user.content as Body[]).filter((p) => p.type === 'image_url');
    expect(images).toHaveLength(1);
    expect(images[0]?.image_url.url).toBe(`data:image/jpeg;base64,${JPEG.toString('base64')}`);
  });

  test('sends up to three images in one request as sides of one package', async () => {
    const { client, calls } = fakeClient(fixture('label-ok'));
    const r = await createMuseSparkLabelReader(client).read([JPEG, JPEG2, JPEG], CTX);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const user = ((calls[0] as Body).messages as Body[]).find((m) => m.role === 'user') as Body;
    const parts = user.content as Body[];
    const images = parts.filter((p) => p.type === 'image_url');
    expect(images.map((p) => p.image_url.url)).toEqual([
      `data:image/jpeg;base64,${JPEG.toString('base64')}`,
      `data:image/jpeg;base64,${JPEG2.toString('base64')}`,
      `data:image/jpeg;base64,${JPEG.toString('base64')}`,
    ]);
    const text = parts.find((p) => p.type === 'text')?.text as string;
    expect(text).toMatch(/3 photos/);
    expect(text).toMatch(/same package/i);
  });

  test('rejects zero or more than three images without calling the model', async () => {
    const { client, calls } = fakeClient(fixture('label-ok'));
    const reader = createMuseSparkLabelReader(client);
    expect(await reader.read([], CTX)).toEqual({
      ok: false,
      code: 'OCR_FAILED',
      detail: 'bad_image_count',
    });
    expect(await reader.read([JPEG, JPEG, JPEG, JPEG], CTX)).toEqual({
      ok: false,
      code: 'OCR_FAILED',
      detail: 'bad_image_count',
    });
    expect(calls).toHaveLength(0);
  });

  test('retries once on invalid JSON and succeeds', async () => {
    const { client, calls } = fakeClient(fixture('label-invalid-json'), fixture('label-ok'));
    const r = await createMuseSparkLabelReader(client).read([JPEG], CTX);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test('invalid output twice is OCR_FAILED', async () => {
    const { client, calls } = fakeClient(
      fixture('label-invalid-json'),
      fixture('label-bad-schema'),
    );
    const r = await createMuseSparkLabelReader(client).read([JPEG], CTX);
    expect(r).toEqual({ ok: false, code: 'OCR_FAILED', detail: 'invalid_output' });
    expect(calls).toHaveLength(2);
  });

  test('retries on finish_reason length', async () => {
    const { client, calls } = fakeClient(fixture('label-length'), fixture('label-ok'));
    const r = await createMuseSparkLabelReader(client).read([JPEG], CTX);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test('a contributor model aborts with OCR_FAILED and is not retried', async () => {
    const { client, calls } = fakeClient(fixture('label-contributor'), fixture('label-ok'));
    const r = await createMuseSparkLabelReader(client).read([JPEG], CTX);
    expect(r).toEqual({ ok: false, code: 'OCR_FAILED', detail: 'contributor_model' });
    expect(calls).toHaveLength(1);
  });

  test('a contributor model on the retry also aborts', async () => {
    const { client } = fakeClient(fixture('label-invalid-json'), fixture('label-contributor'));
    const r = await createMuseSparkLabelReader(client).read([JPEG], CTX);
    expect(r).toEqual({ ok: false, code: 'OCR_FAILED', detail: 'contributor_model' });
  });

  test('a response with no model field is treated as unverified and aborts', async () => {
    const res = { ...(fixture('label-ok') as Body) };
    delete res.model;
    const { client, calls } = fakeClient(res, fixture('label-ok'));
    const r = await createMuseSparkLabelReader(client).read([JPEG], CTX);
    expect(r).toEqual({ ok: false, code: 'OCR_FAILED', detail: 'contributor_model' });
    expect(calls).toHaveLength(1);
  });

  test('a client error is OCR_FAILED, not a throw', async () => {
    const { client } = fakeClient(new Error('ECONNRESET'));
    const r = await createMuseSparkLabelReader(client).read([JPEG], CTX);
    expect(r).toEqual({ ok: false, code: 'OCR_FAILED', detail: 'request_failed' });
  });

  test('reports usage for every completion, including the failed first attempt', async () => {
    const usage: ModelUsage[] = [];
    const { client } = fakeClient(fixture('label-invalid-json'), fixture('label-ok'));
    await createMuseSparkLabelReader(client, { onUsage: (u) => usage.push(u) }).read([JPEG], CTX);
    expect(usage).toEqual([
      { prompt_tokens: 1800, completion_tokens: 420 },
      { prompt_tokens: 1800, completion_tokens: 420 },
    ]);
  });
});

/* ---------------------------------------------------------------- answerer */

function lf(key: FieldKey, value: string | null, legibility: LabelField['legibility'] = 'clear') {
  return { key, value, legibility, evidenceText: value, imageIndex: 0, notes: null };
}

const LABEL: ExtractedLabel = {
  imageKind: 'label',
  fields: [
    lf('brandName', 'Paracelin 500'),
    lf('genericNames', 'Paracetamol'),
    lf('strength', '500 mg', 'partial'),
    lf('directions', 'Adults: 1 tablet every 4 to 6 hours as needed.'),
    lf('warnings', 'Do not exceed the stated dose.  Keep out of reach of children.'),
    lf('registrationNumber', 'DR-XY12345'),
    lf('rxOrOtc', null),
  ],
  rawText: 'DEMO DATA Paracelin 500 Paracetamol 500 mg. Store in a cool, dry place.',
  warnings: [],
};

const MATCH: MatchAssessment = {
  status: 'partial',
  matched: ['brandName', 'registrationNumber'],
  conflicting: [],
  missing: ['strength'],
  candidates: [
    {
      provider: 'ph-fda',
      sourceUrl: 'https://verification.fda.gov.ph/drugs/DR-XY12345',
      registrationNumber: 'DR-XY12345',
      brandName: 'Paracelin 500',
      genericName: 'Paracetamol',
      strengthForm: '500 mg Tablet',
      manufacturer: 'Demo Pharma Labs Inc.',
      classification: 'Household Remedy',
      registrationExpiry: '2031-03-14',
      checkedAt: '2026-10-27T00:00:00.000Z',
    },
  ],
  advisories: [],
  limitations: [],
};

function input(
  question: string,
  intent = 'read_label',
  over: Partial<AnswerInput> = {},
): AnswerInput {
  return { label: LABEL, match: MATCH, question, intent, ...over };
}

describe('createMuseSparkAnswerer', () => {
  test('a grounded answer citing a clear field is answered', async () => {
    const { client, calls } = fakeClient(fixture('answer-ok'));
    const a = await createMuseSparkAnswerer(client).answer(
      input('Explain the directions in simpler words.', 'explain_text'),
      CTX,
    );
    expect(AnswerSchema.safeParse(a).success).toBe(true);
    expect(a.status).toBe('answered');
    expect(a.text).toBe(
      'The directions printed on the pack say adults take 1 tablet every 4 to 6 hours as needed.',
    );
    expect(a.citedFields).toEqual(['directions']);
    expect(a.safetyNotice).toBeNull();
    expect(a.spokenChunks.at(-1)).toBe(FINAL_LINE);
    expect(calls).toHaveLength(1);
  });

  test('sends evidence JSON only: no image, no registry rows, strict answer schema', async () => {
    const { client, calls } = fakeClient(fixture('answer-ok'));
    await createMuseSparkAnswerer(client).answer(input('Can you read this label?'), CTX);
    const body = calls[0] as Body;
    expect(body.model).toBe('muse-spark-1.3');
    expect(body.reasoning_effort).toBe('low');
    expect(body.max_tokens).toBe(4000);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    const schema = body.response_format.json_schema.schema;
    expect(JSON.stringify(schema)).not.toContain('$ref');
    expect([...schema.required].sort()).toEqual(['citedFields', 'text']);
    expect(schema.properties.citedFields.items.enum).toEqual(KEYS);
    const messages = body.messages as Body[];
    const system = messages.find((m) => m.role === 'system')?.content as string;
    expect(system).toMatch(/only/i);
    expect(system).toMatch(/dose|dosing/i);
    expect(system).toMatch(/cite/i);
    const user = messages.find((m) => m.role === 'user')?.content;
    expect(typeof user).toBe('string');
    const sent = JSON.parse(user as string) as Body;
    expect(sent.question).toBe('Can you read this label?');
    expect(sent.fields).toContainEqual({
      key: 'brandName',
      value: 'Paracelin 500',
      legibility: 'clear',
    });
    expect(sent.match.status).toBe('partial');
    // registry rows (and their certificate expiry) never reach the model
    expect(user).not.toContain('registrationExpiry');
    expect(user).not.toContain('2031-03-14');
    expect(user).not.toContain('data:image');
  });

  test('citing a field with no printed value is unclear', async () => {
    const { client } = fakeClient(fixture('answer-unknown-field'));
    const a = await createMuseSparkAnswerer(client).answer(input('Can you read this label?'), CTX);
    expect(a.status).toBe('unclear');
    expect(a.text).toBe(ANSWER_FALLBACK_TEXT);
    expect(a.text.startsWith('I can only answer from what is printed on the label')).toBe(true);
    expect(a.citedFields).toEqual([]);
    expect(a.spokenChunks.at(-1)).toBe(FINAL_LINE);
  });

  test('citing nothing is unclear', async () => {
    const { client } = fakeClient(fixture('answer-uncited'));
    const a = await createMuseSparkAnswerer(client).answer(input('Can you read this label?'), CTX);
    expect(a.status).toBe('unclear');
    expect(a.text).toBe(ANSWER_FALLBACK_TEXT);
  });

  test('citing a field absent from the scan is unclear', async () => {
    const { client } = fakeClient(fixture('answer-ok'));
    const label = { ...LABEL, fields: LABEL.fields.filter((f) => f.key !== 'directions') };
    const a = await createMuseSparkAnswerer(client).answer(
      input('Can you read this label?', 'read_label', { label }),
      CTX,
    );
    expect(a.status).toBe('unclear');
  });

  test('citing a partly legible field appends the uncertainty sentence', async () => {
    const { client } = fakeClient(fixture('answer-partial-field'));
    const a = await createMuseSparkAnswerer(client).answer(
      input('What strength is printed here?', 'strength'),
      CTX,
    );
    expect(ANSWER_UNCERTAIN_SENTENCE).toBe('Part of this was unclear on the label.');
    expect(a.status).toBe('answered');
    expect(a.text).toBe(
      'The strength printed on the pack is 500 mg. Part of this was unclear on the label.',
    );
    expect(a.safetyNotice).toBe('Part of this was unclear on the label.');
    expect(a.spokenChunks).toEqual([
      'The strength printed on the pack is 500 mg.',
      'Part of this was unclear on the label.',
      FINAL_LINE,
    ]);
  });

  test('a cited field the registry contradicts gets the conflict warning', async () => {
    const { client } = fakeClient(fixture('answer-ok'));
    const match: MatchAssessment = {
      ...MATCH,
      status: 'conflicting',
      conflicting: [
        { key: 'directions', labelValue: 'x', referenceValue: '1 tablet every 8 hours.' },
      ],
    };
    const a = await createMuseSparkAnswerer(client).answer(
      input('Can you read this label?', 'read_label', { match }),
      CTX,
    );
    expect(a.status).toBe('answered');
    expect(a.text).toContain(
      'The FDA registry record lists 1 tablet every 8 hours for the directions, which does not match the pack.',
    );
    expect(a.safetyNotice).toContain('does not match the pack');
  });

  test.each(['answer-fake', 'answer-counterfeit', 'answer-advisory-plus'])(
    '%s: an answer calling the pack fake or counterfeit is unclear',
    async (name) => {
      const { client } = fakeClient(fixture(name));
      const match = {
        ...MATCH,
        advisories: [{ title: 'Advisory', url: 'https://www.fda.gov.ph/x' }],
      };
      const a = await createMuseSparkAnswerer(client).answer(
        input('What did the FDA registry say?', 'registry', { match }),
        CTX,
      );
      expect(a.status).toBe('unclear');
      expect(a.text).toBe(ANSWER_FALLBACK_TEXT);
      expect(a.spokenChunks.join(' ')).not.toMatch(/fake|counterfeit/i);
    },
  );

  test('the fixed advisory sentence is allowed when the registry has an advisory', async () => {
    const { client } = fakeClient(fixture('answer-advisory'));
    const match = {
      ...MATCH,
      advisories: [{ title: 'Advisory', url: 'https://www.fda.gov.ph/x' }],
    };
    const a = await createMuseSparkAnswerer(client).answer(
      input('What did the FDA registry say?', 'registry', { match }),
      CTX,
    );
    expect(a.status).toBe('answered');
    expect(a.text).toBe(ADVISORY_SENTENCE);
  });

  test('the fixed advisory sentence without a registry advisory is unclear', async () => {
    const { client } = fakeClient(fixture('answer-advisory'));
    const a = await createMuseSparkAnswerer(client).answer(
      input('What did the FDA registry say?', 'registry'),
      CTX,
    );
    expect(a.status).toBe('unclear');
    expect(a.text).toBe(ANSWER_FALLBACK_TEXT);
  });

  test.each(['What does fake mean?', 'What does "you can take as many as you need" mean?'])(
    'explain_text %s: a phrase not on the label is unclear with no model call',
    async (q) => {
      const { client, calls } = fakeClient(fixture('answer-ok'));
      const a = await createMuseSparkAnswerer(client).answer(input(q, 'explain_text'), CTX);
      expect(PHRASE_NOT_FOUND_TEXT).toBe("I can't find that phrase on this label.");
      expect(a.status).toBe('unclear');
      expect(a.text).toBe("I can't find that phrase on this label.");
      expect(a.citedFields).toEqual([]);
      expect(calls).toHaveLength(0);
    },
  );

  test.each([
    'What does "do not EXCEED the   stated dose" mean?',
    'What does keep out of reach of children mean?',
    "What does the phrase 'cool dry place' mean in simpler words?",
  ])('explain_text %s: a phrase printed on the label goes to the model', async (q) => {
    const { client, calls } = fakeClient(fixture('answer-ok'));
    const a = await createMuseSparkAnswerer(client).answer(input(q, 'explain_text'), CTX);
    expect(calls).toHaveLength(1);
    expect(a.status).toBe('answered');
  });

  test('explain_text about a section, not a phrase, goes to the model', async () => {
    const { client, calls } = fakeClient(fixture('answer-ok'));
    await createMuseSparkAnswerer(client).answer(
      input('What does this warning mean?', 'explain_text'),
      CTX,
    );
    expect(calls).toHaveLength(1);
  });

  test('invalid output twice is unclear, and usage is reported for both calls', async () => {
    const usage: ModelUsage[] = [];
    const { client, calls } = fakeClient(
      fixture('answer-invalid-json'),
      fixture('answer-invalid-json'),
    );
    const a = await createMuseSparkAnswerer(client, { onUsage: (u) => usage.push(u) }).answer(
      input('Can you read this label?'),
      CTX,
    );
    expect(calls).toHaveLength(2);
    expect(a.status).toBe('unclear');
    expect(a.text).toBe(ANSWER_FALLBACK_TEXT);
    expect(usage).toEqual([
      { prompt_tokens: 900, completion_tokens: 40 },
      { prompt_tokens: 900, completion_tokens: 40 },
    ]);
  });

  test('invalid output then a valid one is answered', async () => {
    const { client, calls } = fakeClient(fixture('answer-invalid-json'), fixture('answer-ok'));
    const a = await createMuseSparkAnswerer(client).answer(input('Can you read this label?'), CTX);
    expect(calls).toHaveLength(2);
    expect(a.status).toBe('answered');
  });

  test('a client error propagates to the caller', async () => {
    const { client } = fakeClient(new Error('ECONNRESET'));
    await expect(
      createMuseSparkAnswerer(client).answer(input('Can you read this label?'), CTX),
    ).rejects.toThrow('ECONNRESET');
  });

  test('a contributor model is never answered from', async () => {
    const { client, calls } = fakeClient(fixture('answer-contributor'), fixture('answer-ok'));
    const a = await createMuseSparkAnswerer(client).answer(input('Can you read this label?'), CTX);
    expect(calls).toHaveLength(1);
    expect(a.status).toBe('unclear');
    expect(a.text).toBe(ANSWER_FALLBACK_TEXT);
  });
});

/* -------------------- review round 1: uncertainty decided by content, not citation */

// The brand name carries the strength, so a model can mis-cite it and still be grounded.
const LABEL_MIS: ExtractedLabel = {
  ...LABEL,
  fields: [
    lf('brandName', 'Paracelin 500 mg'),
    lf('genericNames', 'Paracetamol'),
    lf('strength', '500 mg', 'partial'),
    lf('directions', 'Adults: 1 tablet every 4 to 6 hours as needed.'),
    lf('warnings', 'Do not exceed the stated dose. Keep out of reach of children.'),
    lf('expiryDate', 'EXP 12/20?7', 'unreadable'),
  ],
};

async function ask(name: string, intent: string, label: ExtractedLabel = LABEL) {
  const { client } = fakeClient(fixture(name));
  return createMuseSparkAnswerer(client).answer(input('Question?', intent, { label }), CTX);
}

function expectUncertain(a: Awaited<ReturnType<typeof ask>>) {
  expect(AnswerSchema.safeParse(a).success).toBe(true);
  expect(a.status).toBe('answered');
  expect(a.text.endsWith(ANSWER_UNCERTAIN_SENTENCE)).toBe(true);
  expect(a.safetyNotice).toContain(ANSWER_UNCERTAIN_SENTENCE);
  expect(a.spokenChunks.slice(-2)).toEqual([ANSWER_UNCERTAIN_SENTENCE, FINAL_LINE]);
}

describe('answerer uncertainty (finding 1: a mis-cited clear field)', () => {
  test('strength intent: the partial strength stated while citing the brand is uncertain', async () => {
    expectUncertain(await ask('answer-strength-miscited', 'strength', LABEL_MIS));
  });

  test('read_label: text restating a partial value is uncertain whatever it cites', async () => {
    expectUncertain(await ask('answer-strength-miscited', 'read_label', LABEL_MIS));
  });

  test('a mis-cited strength the cited field does not support is unclear', async () => {
    const a = await ask('answer-strength-miscited', 'strength');
    expect(a.status).toBe('unclear');
    expect(a.text).toBe(ANSWER_FALLBACK_TEXT);
  });

  test('an unreadable expiry stated as a date while citing the brand is unclear', async () => {
    const a = await ask('answer-expiry-miscited', 'read_label', LABEL_MIS);
    expect(a.status).toBe('unclear');
    expect(a.text).toBe(ANSWER_FALLBACK_TEXT);
    expect(a.spokenChunks.join(' ')).not.toContain('2027');
  });

  test('talking about an unreadable expiry while citing the brand is uncertain', async () => {
    expectUncertain(await ask('answer-expiry-topic', 'read_label', LABEL_MIS));
  });

  test('unclear_parts intent is always uncertain when a field is not clear', async () => {
    expectUncertain(await ask('answer-ok', 'unclear_parts', LABEL_MIS));
  });

  test('an answer about clear fields only gets no uncertainty sentence', async () => {
    const a = await ask('answer-ok', 'read_label', LABEL_MIS);
    expect(a.status).toBe('answered');
    expect(a.safetyNotice).toBeNull();
  });
});

describe('answerer grounding (finding 2: text must match the cited evidence)', () => {
  test.each([
    ['answer-wrong-dose', 'a dose the directions do not print'],
    ['answer-spelled-number', 'a spelled-out number the directions do not print'],
    ['answer-unit-mismatch', 'the printed number with a different unit'],
    ['answer-wrong-month', 'a month the expiry does not print'],
  ])('%s (%s) is unclear', async (name) => {
    const label = {
      ...LABEL,
      fields: [...LABEL.fields, lf('expiryDate', 'EXP 12/2027')],
    };
    const a = await ask(name, 'read_label', label);
    expect(a.status).toBe('unclear');
    expect(a.text).toBe(ANSWER_FALLBACK_TEXT);
    expect(a.citedFields).toEqual([]);
  });

  test.each([
    ['answer-clinical', 'clinical advice and a dose citing the brand name'],
    ['answer-clinical-cited', 'a safety claim citing a warning that does not make it'],
  ])('%s (%s) is unclear', async (name) => {
    const a = await ask(name, 'read_label');
    expect(a.status).toBe('unclear');
    expect(a.text).toBe(ANSWER_FALLBACK_TEXT);
    expect(a.spokenChunks.join(' ')).not.toMatch(/safe|take 4/i);
  });

  test.each([
    ['half a tablet twice a day.', 'answered'],
    ['1/2 tablet twice a day.', 'answered'],
    ['half a tablet 2 times a day.', 'answered'],
    ['1 tablet twice a day.', 'unclear'],
  ])('spelled-out numbers are grounded either way (printed: %s)', async (printed, status) => {
    const label = {
      ...LABEL,
      fields: LABEL.fields.map((f) =>
        f.key === 'directions' ? lf('directions', `Take ${printed}`) : f,
      ),
    };
    const a = await ask('answer-half', 'read_label', label);
    expect(a.status).toBe(status);
  });

  test('a screened word printed in the cited field is allowed', async () => {
    const a = await ask('answer-printed-children', 'explain_text');
    expect(a.status).toBe('answered');
    expect(a.text).toBe('The warning printed on the pack says keep out of reach of children.');
    expect(a.citedFields).toEqual(['warnings']);
  });
});
