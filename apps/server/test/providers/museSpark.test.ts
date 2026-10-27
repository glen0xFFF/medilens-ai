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
    expectUncertain(await ask('answer-r3-expiry-framed', 'read_label', LABEL_MIS));
  });

  test('review round 3: an expiry remark with a word the brand does not print is unclear', async () => {
    // "on the side" is not printed in the cited brand name (content-word grounding).
    const a = await ask('answer-expiry-topic', 'read_label', LABEL_MIS);
    expect(a.status).toBe('unclear');
    expect(a.text).toBe(ANSWER_FALLBACK_TEXT);
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

/* -------------------- review round 2: frequency, polarity, population, indication */

const LABEL_PROBE: ExtractedLabel = {
  ...LABEL,
  fields: LABEL.fields.map((f) =>
    f.key === 'warnings'
      ? lf(
          'warnings',
          'Do not exceed the stated dose. Keep out of reach of children. Do not take with alcohol.',
        )
      : f,
  ),
};

function expectFallback(a: Awaited<ReturnType<typeof ask>>) {
  expect(AnswerSchema.safeParse(a).success).toBe(true);
  expect(a.status).toBe('unclear');
  expect(a.text).toBe(ANSWER_FALLBACK_TEXT);
  expect(a.citedFields).toEqual([]);
  expect(a.safetyNotice).toBeNull();
}

describe('answerer grounding round 2 (finding 2: same class of unsafe output)', () => {
  test.each([
    ['answer-freq-every-hour', 'every hour, when the label prints every 4 to 6 hours'],
    ['answer-freq-times-a-day', '6 times a day, grounded only by the 6 in 6 hours'],
    ['answer-freq-hourly', 'hourly, with no number at all'],
  ])('%s (%s) is unclear', async (name) => {
    expectFallback(await ask(name, 'read_label', LABEL_PROBE));
  });

  test.each([
    ['Take 1 tablet three times daily.', 'answered'],
    ['Take 1 tablet 3 times a day.', 'answered'],
    ['Take 1 tablet 3 times per day.', 'answered'],
    // Review round 4: the answer drops the printed "with water", so the printed
    // sentence is no longer restated whole.
    ['Take 1 tablet 3 times per day with water.', 'unclear'],
    ['Take 1 tablet every 3 hours.', 'unclear'],
    ['Take 1 tablet once a day for 3 days.', 'unclear'],
  ])('frequency is grounded as a whole (printed: %s)', async (printed, status) => {
    const label = {
      ...LABEL,
      fields: LABEL.fields.map((f) => (f.key === 'directions' ? lf('directions', printed) : f)),
    };
    const a = await ask('answer-freq-three-times', 'read_label', label);
    expect(a.status).toBe(status);
  });

  test.each([
    ['answer-negation-exceed', 'can exceed, when the label prints do not exceed'],
    [
      'answer-negation-alcohol',
      'take with alcohol, when the label prints do not take with alcohol',
    ],
    ['answer-negation-children', 'a "do not" added more than four words before the term'],
  ])('%s (%s) is unclear', async (name) => {
    expectFallback(await ask(name, 'read_label', LABEL_PROBE));
  });

  test('children allowed only by "keep out of reach of children" is unclear', async () => {
    const a = await ask('answer-children-too', 'read_label', LABEL_PROBE);
    expectFallback(a);
    expect(a.spokenChunks.join(' ')).not.toMatch(/children/i);
  });

  test('an indication claim citing the generic name is unclear', async () => {
    const a = await ask('answer-indication', 'read_label', LABEL_PROBE);
    expectFallback(a);
    expect(a.spokenChunks.join(' ')).not.toMatch(/headache|fever/i);
  });

  test.each([
    ['answer-printed-alcohol', 'The warnings say do not take with alcohol.'],
    ['answer-printed-exceed', 'The warnings say do not exceed the stated dose.'],
    [
      'answer-printed-children',
      'The warning printed on the pack says keep out of reach of children.',
    ],
  ])('%s: a screened word restated with its printed context is answered', async (name, text) => {
    const a = await ask(name, 'read_label', LABEL_PROBE);
    expect(a.status).toBe('answered');
    expect(a.text).toBe(text);
    expect(a.safetyNotice).toBeNull();
  });

  test('an indication printed on the label may be restated', async () => {
    const label = {
      ...LABEL,
      fields: [
        ...LABEL.fields.filter((f) => f.key !== 'genericNames'),
        lf('genericNames', 'Paracetamol is good for headaches and fever.'),
      ],
    };
    const a = await ask('answer-indication', 'read_label', label);
    expect(a.status).toBe('answered');
  });
});

describe('answerer uncertainty round 2 (finding 1: a mis-cited paraphrase)', () => {
  const LABEL_ALLERGY: ExtractedLabel = {
    ...LABEL,
    fields: LABEL.fields.map((f) =>
      f.key === 'warnings'
        ? lf(
            'warnings',
            'Do not use if allergic to aspirin. Do not exceed the stated dose.',
            'partial',
          )
        : f,
    ),
  };

  test('review round 3: paraphrasing a partial warning while citing the brand is unclear', async () => {
    // Round 2 flagged this as uncertain; round 3 grounds vocabulary in the cited
    // field, and "use", "allergic" and "aspirin" are not printed in the brand name.
    const a = await ask('answer-allergy-miscited', 'read_label', LABEL_ALLERGY);
    expect(a.status).toBe('unclear');
    expect(a.text).toBe(ANSWER_FALLBACK_TEXT);
  });

  test('review round 3: the same paraphrase citing the brand is unclear when the warning is clear', async () => {
    const label = {
      ...LABEL_ALLERGY,
      fields: LABEL_ALLERGY.fields.map((f) =>
        f.key === 'warnings' ? { ...f, legibility: 'clear' as const } : f,
      ),
    };
    const a = await ask('answer-allergy-miscited', 'read_label', label);
    expect(a.status).toBe('unclear');
    expect(a.text).toBe(ANSWER_FALLBACK_TEXT);
  });

  test('the same paraphrase citing the partial warnings is answered and uncertain', async () => {
    expectUncertain(await ask('answer-r3-ctrl-allergic-reworded', 'read_label', LABEL_ALLERGY));
  });

  test('the same paraphrase citing the clear warnings is answered with no notice', async () => {
    const label = {
      ...LABEL_ALLERGY,
      fields: LABEL_ALLERGY.fields.map((f) =>
        f.key === 'warnings' ? { ...f, legibility: 'clear' as const } : f,
      ),
    };
    const a = await ask('answer-r3-ctrl-allergic-reworded', 'read_label', label);
    expect(a.status).toBe('answered');
    expect(a.safetyNotice).toBeNull();
  });
});

/* -------------------- review round 3: answer vocabulary grounded in cited fields */

function withField(
  base: ExtractedLabel,
  key: FieldKey,
  value: string,
  legibility: LabelField['legibility'] = 'clear',
): ExtractedLabel {
  return {
    ...base,
    fields: [...base.fields.filter((f) => f.key !== key), lf(key, value, legibility)],
  };
}

describe('answerer grounding round 3 (finding 2: every content word must be printed)', () => {
  test.each([
    ['answer-r3-freq-couple', 'every couple of hours'],
    ['answer-r3-freq-few', 'every few hours'],
    ['answer-r3-freq-sooner', 'or sooner if needed'],
    ['answer-r3-freq-as-often', 'or as often as needed'],
    ['answer-r3-freq-morning-night', 'every morning and night'],
    ['answer-r3-freq-another', 'another one right away'],
  ])('(a) %s (%s) citing directions is unclear', async (name) => {
    expectFallback(await ask(name, 'read_label', LABEL_PROBE));
  });

  test.each([
    ['answer-r3-neg-allergic-can', 'Do not use if allergic to aspirin.'],
    ['answer-r3-neg-allergic-even', 'Do not use if allergic to aspirin.'],
    ['answer-r3-neg-allergic-bare', 'Do not use if allergic to aspirin.'],
    ['answer-r3-neg-days', 'Do not use for more than 3 days.'],
    ['answer-r3-neg-days-bare', 'Do not use for more than 3 days.'],
    ['answer-r3-neg-drive', 'Do not drive after taking it.'],
    ['answer-r3-neg-drive-bare', 'Do not drive after taking it.'],
    ['answer-r3-neg-avoid', 'Avoid alcohol.'],
  ])('(b) %s flips the printed warning "%s" and is unclear', async (name, printed) => {
    expectFallback(await ask(name, 'read_label', withField(LABEL_PROBE, 'warnings', printed)));
  });

  test.each([
    ['answer-r3-neg-problem', 'a reversing "not" earlier in the clause'],
    ['answer-r3-neg-harm', 'a reversing "no" earlier in the clause'],
    ['answer-r3-neg-far', 'a "not" more than three words before the printed run'],
  ])('(b2) %s (%s) is unclear', async (name) => {
    expectFallback(await ask(name, 'read_label', LABEL_PROBE));
  });

  // Polarity-only probes: every word is printed and none is a screened clinical term.
  test('(b2) a "not" more than three words before a printed run is not its negation', async () => {
    const label = withField(LABEL_PROBE, 'warnings', 'Do not drive after taking it.');
    expectFallback(await ask('answer-r3-neg-far-drive', 'read_label', label));
  });

  test('(b) a word printed only in an "avoid" clause, restated without it, is unclear', async () => {
    const label = withField(LABEL_PROBE, 'storage', 'Avoid sunlight.');
    expectFallback(await ask('answer-r3-neg-avoid-store', 'read_label', label));
  });

  test.each([
    'answer-r3-pop-teenagers',
    'answer-r3-pop-teens',
    'answer-r3-pop-anyone',
    'answer-r3-pop-older',
  ])('(c) %s: a population the directions do not print is unclear', async (name) => {
    expectFallback(await ask(name, 'read_label', LABEL_PROBE));
  });

  test.each([
    'answer-r3-ind-toothache',
    'answer-r3-ind-temperature',
    'answer-r3-ind-cramps',
    'answer-r3-ind-arthritis',
  ])('(d) %s: an indication the generic name does not print is unclear', async (name) => {
    expectFallback(await ask(name, 'read_label', LABEL_PROBE));
  });

  test.each([
    ['answer-r3-ctrl-allergic', 'Do not use if allergic to aspirin.'],
    ['answer-r3-ctrl-allergic-reworded', 'Do not use if allergic to aspirin.'],
    ['answer-r3-ctrl-days', 'Do not use for more than 3 days.'],
    ['answer-r3-ctrl-drive', 'Do not drive after taking it.'],
    ['answer-r3-ctrl-avoid', 'Avoid alcohol.'],
  ])('control: %s restates "%s" and is answered', async (name, printed) => {
    const a = await ask(name, 'read_label', withField(LABEL_PROBE, 'warnings', printed));
    expect(AnswerSchema.safeParse(a).success).toBe(true);
    expect(a.status).toBe('answered');
    expect(a.safetyNotice).toBeNull();
  });

  test('control: the verbatim directions are answered', async () => {
    const a = await ask('answer-ok', 'read_label', LABEL_PROBE);
    expect(a.status).toBe('answered');
    expect(a.safetyNotice).toBeNull();
  });

  test('control: a verbatim partial storage citing storage is answered and uncertain', async () => {
    const label = withField(LABEL_PROBE, 'storage', 'Store below 30 C in a dry place.', 'partial');
    expectUncertain(await ask('answer-r3-ctrl-storage', 'read_label', label));
  });
});

describe('answerer uncertainty round 3 (finding 1: a zero-overlap mis-cited paraphrase)', () => {
  test.each([
    ['answer-r3-para-storage', 'storage', 'Store below 30 C in a dry place.'],
    ['answer-r3-para-directions', 'directions', 'Adults: 1 tablet every 4 to 6 hours as needed.'],
    ['answer-r3-para-warnings', 'warnings', 'Do not use if allergic to aspirin.'],
    [
      'answer-r3-para-salicylates',
      'warnings',
      'Do not use if allergic to aspirin. Do not exceed the stated dose.',
    ],
  ] as const)(
    '%s: a paraphrase of the partial %s citing the clear brand is not answered',
    async (name, key, printed) => {
      expectFallback(await ask(name, 'read_label', withField(LABEL_PROBE, key, printed, 'partial')));
    },
  );

  test.each([
    ['answer-r3-para-storage', 'storage', 'Store below 30 C in a dry place.'],
    ['answer-r3-para-directions', 'directions', 'Adults: 1 tablet every 4 to 6 hours as needed.'],
  ] as const)(
    '%s: the same paraphrase is not answered when %s is clear either',
    async (name, key, printed) => {
      expectFallback(await ask(name, 'read_label', withField(LABEL_PROBE, key, printed)));
    },
  );
});

/* -------------- review round 4: each printed clause restated whole; no unprinted status */

const ALLERGY = 'Do not use if allergic to aspirin.';
const DRIVE = 'Do not drive after taking it.';
const SUN = 'Store below 30 C. Protect from sunlight.';
const POPULATIONS =
  'Adults: 2 tablets every 6 hours. Children 6 to 12 years: 1 tablet every 6 hours.';

describe('answerer grounding round 4 (finding 2: printed clauses restated whole)', () => {
  test.each([
    ['answer-r4-extra-not', ALLERGY, '(1) an extra "not" inside the printed clause'],
    ['answer-r4-moved-question', ALLERGY, '(2) a negation moved onto the condition across "?"'],
    ['answer-r4-moved-comma', DRIVE, '(2) a negation moved onto the condition across ","'],
    ['answer-r4-dropped-condition', ALLERGY, '(3) the printed condition dropped'],
  ])('%s against the printed "%s" is unclear: %s', async (name, printed) => {
    expectFallback(await ask(name, 'read_label', withField(LABEL_PROBE, 'warnings', printed)));
  });

  test.each(['answer-r4-in-reach', 'answer-r4-reach'])(
    '(3) %s drops the printed "out" and is unclear',
    async (name) => {
      const a = await ask(name, 'read_label', LABEL_PROBE);
      expectFallback(a);
      expect(a.spokenChunks.join(' ')).not.toMatch(/reach/i);
    },
  );

  test('(3) "Store below 30 C in sunlight." drops the printed "Protect from" and is unclear', async () => {
    const a = await ask('answer-r4-sunlight', 'read_label', withField(LABEL_PROBE, 'storage', SUN));
    expectFallback(a);
    expect(a.spokenChunks.join(' ')).not.toMatch(/sunlight/i);
  });

  test.each(['answer-r4-children-dose', 'answer-r4-children-as-needed'])(
    '(4) %s joins the printed "children" to the dosing and is unclear',
    async (name) => {
      const a = await ask(name, 'read_label', LABEL_PROBE);
      expectFallback(a);
      expect(a.spokenChunks.join(' ')).not.toMatch(/children/i);
    },
  );

  test('(4) a dose moved from one printed population to another is unclear', async () => {
    const label = withField(LABEL_PROBE, 'directions', POPULATIONS);
    const a = await ask('answer-r4-swap-population', 'read_label', label);
    expectFallback(a);
    expect(a.spokenChunks.join(' ')).not.toMatch(/2 tablets/i);
  });

  test('(4) printed numbers restated without their printed sentence are unclear', async () => {
    expectFallback(await ask('answer-r4-bare-numbers', 'read_label', LABEL_PROBE));
  });

  test.each([
    'answer-r4-registered',
    'answer-r4-registered-clear',
    'answer-r4-otc',
    'answer-r4-prescription',
  ])('(5) %s states a status the cited generic name does not print and is unclear', async (name) => {
    const a = await ask(name, 'read_label', LABEL_PROBE);
    expectFallback(a);
    expect(a.spokenChunks.join(' ')).not.toMatch(/regist|otc|prescription/i);
  });

  test('(5) "registration" is framing only as "registration number"', async () => {
    expectFallback(await ask('answer-r4-registration-clear', 'read_label', LABEL_PROBE));
  });

  test('(5) a prescription status the cited field does not print is unclear', async () => {
    const label = withField(LABEL_PROBE, 'rxOrOtc', 'Prescription drug');
    const a = await ask('answer-r4-otc-cited', 'read_label', label);
    expectFallback(a);
    expect(a.spokenChunks.join(' ')).not.toMatch(/otc/i);
  });

  test('(5) "made by" is framing only when the manufacturer is cited', async () => {
    expectFallback(await ask('answer-r4-made-by', 'read_label', LABEL_PROBE));
  });

  test('(5) a registry status built from a word another field prints is unclear', async () => {
    const label = withField(
      LABEL_PROBE,
      'manufacturer',
      'Registered and distributed by Demo Pharma Labs Inc.',
    );
    expectFallback(await ask('answer-r4-registered-printed', 'read_label', label));
  });

  test('a negation that no cited field prints is unclear', async () => {
    expectFallback(await ask('answer-r4-not-medicine', 'read_label', LABEL_PROBE));
  });

  test.each([
    ['answer-r3-ctrl-allergic', 'warnings', ALLERGY],
    [
      'answer-r4-ctrl-reach',
      'warnings',
      'Do not exceed the stated dose. Keep out of reach of children. Do not take with alcohol.',
    ],
    ['answer-r4-ctrl-storage-both', 'storage', SUN],
    ['answer-r4-ctrl-populations', 'directions', POPULATIONS],
    ['answer-r4-ctrl-regno', 'registrationNumber', 'DR-XY12345'],
    ['answer-r4-ctrl-manufacturer', 'manufacturer', 'Demo Pharma Labs Inc.'],
    ['answer-r4-ctrl-rx-printed', 'rxOrOtc', 'Prescription drug'],
  ] as const)('control: %s restates the printed %s and is answered', async (name, key, printed) => {
    const a = await ask(name, 'read_label', withField(LABEL_PROBE, key, printed));
    const recorded = fixture(name) as Body;
    const { text } = JSON.parse(recorded.choices[0].message.content as string) as Body;
    expect(AnswerSchema.safeParse(a).success).toBe(true);
    expect(a.status).toBe('answered');
    expect(a.text).toBe(text);
    expect(a.safetyNotice).toBeNull();
  });

  test('a negation before a printed sentence that starts with "clear" is unclear', async () => {
    const label = withField(LABEL_PROBE, 'directions', 'Clear nasal passages before use.');
    expectFallback(await ask('answer-r4-not-clear-printed', 'read_label', label));
  });

  test('control: a negation before a legibility word is answered and uncertain', async () => {
    expectUncertain(await ask('answer-r4-ctrl-not-clear', 'unclear_parts', LABEL_PROBE));
  });
});

describe('answerer grounding round 4 (dosing words and inserted "take")', () => {
  const CHILD_ASK = 'Adults: 1 tablet every 4 to 6 hours. Children under 12: ask a doctor.';

  test.each([
    ['answer-r4-take-strength', '"Take 500 mg." citing only the strength'],
    ['answer-r4-dose-strength', '"The dose is 500 mg." citing only the strength'],
  ])('%s (%s) states a dose the label does not print and is unclear', async (name) => {
    const a = await ask(name, 'read_label', withField(LABEL_PROBE, 'strength', '500 mg'));
    expectFallback(a);
    expect(a.spokenChunks.join(' ')).not.toMatch(/500/);
  });

  test('"take" inserted after a printed population with no printed dose is unclear', async () => {
    const label = withField(LABEL_PROBE, 'directions', CHILD_ASK);
    const a = await ask('answer-r4-slot-population', 'read_label', label);
    expectFallback(a);
    expect(a.spokenChunks.join(' ')).not.toMatch(/children/i);
  });

  test('"take" inserted inside a printed warning to make a new instruction is unclear', async () => {
    const label = withField(LABEL_PROBE, 'warnings', ALLERGY);
    expectFallback(await ask('answer-r4-gap-aspirin', 'read_label', label));
  });

  test('a second "take" inserted after a printed "do not take" is unclear', async () => {
    const label = withField(LABEL_PROBE, 'warnings', 'Do not take with grapefruit juice.');
    expectFallback(await ask('answer-r4-gap-take', 'read_label', label));
  });

  test('the same shape with a screened word is unclear (round-2 screen guard)', async () => {
    expectFallback(await ask('answer-r4-gap-alcohol', 'read_label', LABEL_PROBE));
  });

  test.each([
    ['answer-ok', 'directions', 'Adults: 1 tablet every 4 to 6 hours as needed.'],
    ['answer-r4-ctrl-colon', 'directions', 'Adults: 1 tablet every 4 to 6 hours as needed.'],
    ['answer-r4-ctrl-take-prefix', 'directions', '1 tablet every 4 to 6 hours as needed.'],
    ['answer-r4-ctrl-dosage-form', 'dosageForm', 'Tablet'],
  ] as const)('control: %s restates the printed %s and is answered', async (name, key, printed) => {
    const a = await ask(name, 'read_label', withField(LABEL_PROBE, key, printed));
    const recorded = fixture(name) as Body;
    const { text } = JSON.parse(recorded.choices[0].message.content as string) as Body;
    expect(a.status).toBe('answered');
    expect(a.text).toBe(text);
    expect(a.safetyNotice).toBeNull();
  });
});

/* ------- review round 5: a printed line break keeps a heading with the line under it */

const TABLE_COLON =
  'Adults:\n2 tablets every 6 hours.\nChildren 6 to 12 years:\n1 tablet every 6 hours.';
const TABLE_BARE =
  'Adults and children over 12 years\n2 tablets every 4 hours\nChildren 6 to 12 years\n1 tablet every 4 hours';
const TABLE_DOTS = 'Adults.\n2 tablets every 6 hours.\nChildren 6 to 12 years.\n1 tablet every 6 hours.';
const WRAPPED_LIMIT = 'Do not exceed\n8 tablets in 24 hours.';
const BARE_DOSE = '1 tablet every 4 to 6 hours as needed.';

function expectRecordedAnswer(a: Awaited<ReturnType<typeof ask>>, name: string) {
  const recorded = fixture(name) as Body;
  const { text } = JSON.parse(recorded.choices[0].message.content as string) as Body;
  expect(AnswerSchema.safeParse(a).success).toBe(true);
  expect(a.status).toBe('answered');
  expect(a.text).toBe(text);
  expect(a.safetyNotice).toBeNull();
}

describe('answerer grounding round 5 (finding 2 (A): printed line breaks)', () => {
  test.each([
    ['answer-r5-table-colon', 'with a colon'],
    ['answer-r5-table-nocolon', 'without a colon'],
    ['answer-r5-table-take', 'with "take"'],
  ])('%s moves the adult dose under the printed children heading (%s) and is unclear', async (name) => {
    const a = await ask(name, 'read_label', withField(LABEL_PROBE, 'directions', TABLE_COLON));
    expectFallback(a);
    expect(a.spokenChunks.join(' ')).not.toMatch(/2 tablets/);
  });

  test('a heading and dose swapped across an unpunctuated table (with ",") is unclear', async () => {
    const label = withField(LABEL_PROBE, 'directions', TABLE_BARE);
    const a = await ask('answer-r5-table-bare-comma', 'read_label', label);
    expectFallback(a);
    expect(a.spokenChunks.join(' ')).not.toMatch(/2 tablets/);
  });

  test('a wrapped "Do not exceed" limit restated as the bare amount is unclear', async () => {
    const label = withField(LABEL_PROBE, 'warnings', WRAPPED_LIMIT);
    const a = await ask('answer-r5-limit-bare', 'read_label', label);
    expectFallback(a);
    expect(a.spokenChunks.join(' ')).not.toMatch(/8 tablets/);
  });

  test.each(['answer-r5-table-dots', 'answer-r5-table-dots-take'])(
    '%s joins a heading to a dose that is not printed after it, where each line ends in a period, and is unclear',
    async (name) => {
      const a = await ask(name, 'read_label', withField(LABEL_PROBE, 'directions', TABLE_DOTS));
      expectFallback(a);
      expect(a.spokenChunks.join(' ')).not.toMatch(/2 tablets/);
    },
  );

  test.each([
    ['answer-r5-limit-take', 'at a wrapped line break', WRAPPED_LIMIT],
    ['answer-r5-max-take', 'at a printed colon', 'Maximum daily dose: 8 tablets.'],
  ])('%s puts "take" after a printed limit (%s) and is unclear', async (name, _why, printed) => {
    const a = await ask(name, 'read_label', withField(LABEL_PROBE, 'warnings', printed));
    expectFallback(a);
    expect(a.spokenChunks.join(' ')).not.toMatch(/8 tablets/);
  });

  test('a printed dose sentence given another printed sentence as its heading is unclear', async () => {
    const label = withField(LABEL_PROBE, 'directions', BARE_DOSE);
    const a = await ask('answer-r5-reach-dose', 'read_label', label);
    expectFallback(a);
    expect(a.spokenChunks.join(' ')).not.toMatch(/children/i);
  });

  test.each([
    ['answer-r5-ctrl-table-row', 'directions', TABLE_COLON],
    ['answer-r5-ctrl-table-row-take', 'directions', TABLE_COLON],
    ['answer-r5-ctrl-table-bare-whole', 'directions', TABLE_BARE],
    ['answer-r5-ctrl-limit', 'warnings', WRAPPED_LIMIT],
    ['answer-r5-ctrl-table-dots-row', 'directions', TABLE_DOTS],
  ] as const)('control: %s restates a printed %s row verbatim and is answered', async (name, key, printed) => {
    expectRecordedAnswer(await ask(name, 'read_label', withField(LABEL_PROBE, key, printed)), name);
  });
});

describe('answerer grounding round 5 (finding 2 (B): population words from a brand or maker)', () => {
  const KIDS_BRAND = withField(
    withField(LABEL_PROBE, 'brandName', 'Paracelin Kids'),
    'directions',
    BARE_DOSE,
  );
  const CHILD_MAKER = withField(
    withField(LABEL_PROBE, 'manufacturer', "Children's Health Pharma Inc."),
    'directions',
    BARE_DOSE,
  );
  // Directions stay the LABEL_PROBE "Adults: 1 tablet every 4 to 6 hours as needed."
  const CHILD_MAKER_ADULTS = withField(LABEL_PROBE, 'manufacturer', "Children's Health Pharma Inc.");

  test.each([
    ['answer-r5-kids-brand', '"Kids:" taken from the brand name', KIDS_BRAND],
    ['answer-r5-kids-brand-whole', 'the whole brand name as a heading', KIDS_BRAND],
    ['answer-r5-kids-strength', '"Kids:" before the strength', KIDS_BRAND],
    ['answer-r5-children-maker', '"Children:" taken from the manufacturer', CHILD_MAKER],
    ['answer-r5-children-adults-maker', '"Children:" before a printed "Adults:"', CHILD_MAKER_ADULTS],
    ['answer-r5-maker-whole-dose', 'the whole manufacturer as a heading', CHILD_MAKER],
  ] as const)('%s puts a population word before a dose (%s) and is unclear', async (name, _why, label) => {
    const a = await ask(name, 'read_label', label);
    expectFallback(a);
    expect(a.spokenChunks.join(' ')).not.toMatch(/kids|children/i);
  });

  test.each([
    ['answer-r5-kids-brand-adults', 'the brand name', withField(LABEL_PROBE, 'brandName', 'Paracelin Kids')],
    ['answer-r5-maker-whole-adults', 'the manufacturer', CHILD_MAKER_ADULTS],
  ] as const)(
    '%s: a population word grounded only by %s, in a sentence with a printed dose, is unclear',
    async (name, _why, label) => {
      const a = await ask(name, 'read_label', label);
      expectFallback(a);
      expect(a.spokenChunks.join(' ')).not.toMatch(/kids|children/i);
    },
  );

  test('the brand name as a heading before a printed limit is unclear', async () => {
    const label = withField(KIDS_BRAND, 'warnings', WRAPPED_LIMIT);
    const a = await ask('answer-r5-kids-limit', 'read_label', label);
    expectFallback(a);
    expect(a.spokenChunks.join(' ')).not.toMatch(/kids/i);
  });

  test('control: the brand name restated whole is answered', async () => {
    expectRecordedAnswer(
      await ask('answer-r5-ctrl-brand-kids', 'read_label', KIDS_BRAND),
      'answer-r5-ctrl-brand-kids',
    );
  });
});
