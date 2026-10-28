import {
  AnalysisResultSchema,
  type ExtractedLabel,
  type FieldKey,
  type LabelField,
  type Legibility,
  type ReferenceRecord,
} from '@medilens/contracts';
import { describe, expect, test } from 'vitest';
import { MAX_CACHE_ENTRIES } from '../../src/config';
import { FINAL_LINE, LOOSE_PILL_SENTENCE, NOT_A_LABEL_SENTENCE } from '../../src/domain/summary';
import {
  analyzeImages,
  analyzeScenario,
  PipelineError,
  type PipelineDeps,
} from '../../src/pipeline/analyze';
import { createResultStore } from '../../src/pipeline/store';
import { FixtureLabelReader, FixtureReferenceProvider } from '../../src/providers/fixture';
import type {
  LabelReader,
  ProviderContext,
  ReadResult,
  ReferenceProvider,
  ReferenceQuery,
  ReferenceSearchResult,
} from '../../src/providers/types';
import { blurredJpeg, sharpJpeg } from '../helpers/images';

/* All label and registry data here is synthetic DEMO DATA with fictional names. */

const T0 = Date.parse('2026-10-27T08:00:00.000Z');
const FIFTEEN_MIN = 15 * 60 * 1000;
const NOT_ENOUGH_TEXT = 'Not enough clear text to search the registry.';

function field(key: FieldKey, value: string | null, legibility: Legibility = 'clear'): LabelField {
  return { key, value, legibility, evidenceText: value, imageIndex: 0, notes: null };
}

function label(
  fields: LabelField[],
  imageKind: ExtractedLabel['imageKind'] = 'label',
): ExtractedLabel {
  return { imageKind, fields, rawText: 'DEMO DATA', warnings: [] };
}

const PARACELIN = label([
  field('brandName', 'Paracelin 500'),
  field('genericNames', 'Paracetamol'),
  field('strength', '500 mg'),
  field('dosageForm', 'Tablet'),
  field('registrationNumber', 'dr-xy 900001'),
]);

const RECORD: ReferenceRecord = {
  provider: 'demo-fixture',
  sourceUrl: 'https://verification.fda.gov.ph/?q=DR-XY900001',
  registrationNumber: 'DR-XY900001',
  brandName: 'Paracelin 500',
  genericName: 'Paracetamol',
  strengthForm: '500 mg Tablet',
  manufacturer: null,
  classification: null,
  registrationExpiry: '2030-12-31',
  checkedAt: '2026-10-27T00:00:00.000Z',
};

class StubReader implements LabelReader {
  calls: { images: Buffer[]; ctx: ProviderContext }[] = [];
  constructor(private readonly result: ReadResult) {}
  read(images: Buffer[], ctx: ProviderContext): Promise<ReadResult> {
    this.calls.push({ images, ctx });
    return Promise.resolve(structuredClone(this.result));
  }
}

class StubReferences implements ReferenceProvider {
  calls: { q: ReferenceQuery; ctx: ProviderContext }[] = [];
  constructor(private readonly result: ReferenceSearchResult | Error) {}
  search(q: ReferenceQuery, ctx: ProviderContext): Promise<ReferenceSearchResult> {
    this.calls.push({ q, ctx });
    if (this.result instanceof Error) return Promise.reject(this.result);
    return Promise.resolve(structuredClone(this.result));
  }
}

function okRead(l: ExtractedLabel): ReadResult {
  return { ok: true, label: l, model: 'muse-spark-1.3' };
}

function setup(opts: {
  read?: ReadResult;
  search?: ReferenceSearchResult | Error;
  isDemo?: boolean;
}) {
  let clock = T0;
  let ids = 0;
  const reader = new StubReader(opts.read ?? okRead(PARACELIN));
  const references = new StubReferences(
    opts.search ?? { kind: 'ok', records: [RECORD], advisories: [] },
  );
  const now = () => clock;
  const store = createResultStore(now);
  const deps: PipelineDeps = {
    reader,
    references,
    store,
    now,
    newId: () => `id-${++ids}`,
    isDemo: opts.isDemo ?? false,
  };
  return {
    deps,
    reader,
    references,
    store,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function expectPipelineError(p: Promise<unknown>, code: string): Promise<void> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PipelineError);
  expect((err as PipelineError).code).toBe(code);
}

describe('createResultStore', () => {
  test('returns a stored result until 15 minutes have passed, then undefined', async () => {
    const { deps, store, advance } = setup({});
    const result = await analyzeImages([await sharpJpeg()], deps);
    advance(FIFTEEN_MIN - 1);
    expect(store.get(result.id)).toEqual(result);
    advance(1);
    expect(store.get(result.id)).toBeUndefined();
  });

  test('unknown id is undefined', () => {
    const store = createResultStore(() => T0);
    expect(store.get('nope')).toBeUndefined();
  });

  test('callers cannot mutate the stored copy', async () => {
    const { deps, store } = setup({});
    const result = await analyzeImages([await sharpJpeg()], deps);
    result.explanation.spokenChunks.push('tampered');
    const got = store.get(result.id);
    got?.explanation.spokenChunks.push('tampered again');
    expect(store.get(result.id)?.explanation.spokenChunks).not.toContain('tampered');
    expect(store.get(result.id)?.explanation.spokenChunks).not.toContain('tampered again');
  });

  test('honours a custom ttl', () => {
    let clock = T0;
    const store = createResultStore(() => clock, 1000);
    expect(store.ttlMs).toBe(1000);
    const r = AnalysisResultSchema.parse({
      id: 'x',
      isDemo: true,
      createdAt: new Date(T0).toISOString(),
      expiresAt: new Date(T0 + 1000).toISOString(),
      pipelineState: 'label_unreadable',
      quality: { ok: false, sharpness: 1, luminance: 100, glareFraction: 0, reasons: ['BLURRY'] },
      label: null,
      match: {
        status: 'not_attempted',
        matched: [],
        conflicting: [],
        missing: [],
        candidates: [],
        advisories: [],
        limitations: [],
      },
      explanation: { displayText: '', spokenChunks: [], safetyNotices: [], supportingFields: [] },
      imageRetention: 'none',
    });
    store.put(r);
    clock += 999;
    expect(store.get('x')).toBeDefined();
    clock += 1;
    expect(store.get('x')).toBeUndefined();
  });
});

describe('analyzeImages', () => {
  test('happy path: lookup, match, summary, stored and retrievable', async () => {
    const { deps, reader, references, store } = setup({});
    const result = await analyzeImages([await sharpJpeg()], deps);

    expect(AnalysisResultSchema.parse(result)).toEqual(result);
    expect(result.id).toBe('id-1');
    expect(result.isDemo).toBe(false);
    expect(result.imageRetention).toBe('none');
    expect(result.pipelineState).toBe('explanation_ready');
    expect(result.quality.ok).toBe(true);
    expect(result.label).toEqual(PARACELIN);
    expect(result.match.status).toBe('verified');
    expect(result.createdAt).toBe(new Date(T0).toISOString());
    expect(result.expiresAt).toBe(new Date(T0 + FIFTEEN_MIN).toISOString());
    expect(result.explanation.spokenChunks.at(-1)).toBe(FINAL_LINE);
    expect(result.explanation.displayText).toContain('Paracelin 500');

    expect(reader.calls).toHaveLength(1);
    expect(references.calls).toHaveLength(1);
    expect(references.calls[0]?.q).toEqual({
      registrationNumber: 'DR-XY900001',
      name: 'Paracelin 500',
    });
    expect(store.get(result.id)).toEqual(result);
  });

  test('the reader gets normalised JPEG buffers, one per image, with no scenario id', async () => {
    const { deps, reader } = setup({});
    await analyzeImages([await sharpJpeg(), await sharpJpeg()], deps);
    const call = reader.calls[0];
    expect(call?.images).toHaveLength(2);
    for (const img of call?.images ?? []) {
      expect([...img.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    }
    expect(call?.ctx.scenarioId).toBeUndefined();
  });

  test('isDemo follows deps', async () => {
    const { deps } = setup({ isDemo: true });
    const result = await analyzeImages([await sharpJpeg()], deps);
    expect(result.isDemo).toBe(true);
  });

  test('blurry photo: label_unreadable, reader and registry never called', async () => {
    const { deps, reader, references, store } = setup({});
    const result = await analyzeImages([await blurredJpeg()], deps);

    expect(AnalysisResultSchema.parse(result)).toEqual(result);
    expect(reader.calls).toHaveLength(0);
    expect(references.calls).toHaveLength(0);
    expect(result.pipelineState).toBe('label_unreadable');
    expect(result.label).toBeNull();
    expect(result.quality.ok).toBe(false);
    expect(result.quality.reasons).toContain('BLURRY');
    expect(result.match.status).toBe('not_attempted');
    expect(result.match.limitations).toEqual(['Registry lookup was not attempted.']);
    expect(result.explanation.displayText).toContain('The photo is blurry.');
    expect(result.explanation.spokenChunks.at(-1)).toBe(FINAL_LINE);
    expect(result.imageRetention).toBe('none');
    expect(store.get(result.id)).toEqual(result);
  });

  test('one blurry photo among sharp ones fails the whole scan', async () => {
    const { deps, reader } = setup({});
    const result = await analyzeImages([await sharpJpeg(), await blurredJpeg()], deps);
    expect(reader.calls).toHaveLength(0);
    expect(result.pipelineState).toBe('label_unreadable');
    expect(result.quality.reasons).toContain('BLURRY');
  });

  test('loose pill: no lookup, loose-pill summary', async () => {
    const pill = label([field('brandName', null, 'unreadable')], 'loose_pill');
    const { deps, references } = setup({ read: okRead(pill) });
    const result = await analyzeImages([await sharpJpeg()], deps);

    expect(references.calls).toHaveLength(0);
    expect(result.pipelineState).toBe('loose_pill');
    expect(result.match.status).toBe('not_attempted');
    expect(result.explanation.spokenChunks).toContain(LOOSE_PILL_SENTENCE);
    expect(result.explanation.safetyNotices).toContain(LOOSE_PILL_SENTENCE);
  });

  test('not medicine: no lookup, "no medicine label" summary', async () => {
    const { deps, references } = setup({ read: okRead(label([], 'not_medicine')) });
    const result = await analyzeImages([await sharpJpeg()], deps);

    expect(references.calls).toHaveLength(0);
    expect(result.pipelineState).toBe('not_a_label');
    expect(result.match.status).toBe('not_attempted');
    expect(NOT_A_LABEL_SENTENCE).toBe("I couldn't find a medicine label in this photo.");
    expect(result.explanation.spokenChunks).toContain(
      "I couldn't find a medicine label in this photo.",
    );
  });

  test('reader says unreadable: no lookup, label_unreadable with the label kept, text emptied', async () => {
    const unreadable = label([], 'unreadable');
    const { deps, references } = setup({ read: okRead(unreadable) });
    const result = await analyzeImages([await sharpJpeg()], deps);

    expect(references.calls).toHaveLength(0);
    expect(result.pipelineState).toBe('label_unreadable');
    // final review I2: no transcribed text is kept for an unreadable read
    expect(result.label).toEqual({ ...unreadable, rawText: '' });
    expect(result.match.status).toBe('not_attempted');
    expect(result.explanation.displayText).toContain("I couldn't read this label.");
  });

  test('query uses the generic name when the brand is not clear', async () => {
    const l = label([
      field('brandName', 'Paracel', 'partial'),
      field('genericNames', 'Paracetamol'),
      field('registrationNumber', 'DR-XY900001'),
    ]);
    const { deps, references } = setup({ read: okRead(l) });
    await analyzeImages([await sharpJpeg()], deps);
    expect(references.calls[0]?.q).toEqual({
      registrationNumber: 'DR-XY900001',
      name: 'Paracetamol',
    });
  });

  test('query omits a registration number that is not clear or not well-formed', async () => {
    for (const reg of [
      field('registrationNumber', 'DR-XY900001', 'partial'),
      field('registrationNumber', 'see box'),
    ]) {
      const l = label([field('brandName', 'Paracelin 500'), reg]);
      const { deps, references } = setup({ read: okRead(l) });
      await analyzeImages([await sharpJpeg()], deps);
      expect(references.calls[0]?.q).toEqual({ name: 'Paracelin 500' });
    }
  });

  test('a registration number alone is enough to search', async () => {
    const l = label([
      field('brandName', null, 'unreadable'),
      field('registrationNumber', 'DR-XY900001'),
    ]);
    const { deps, references } = setup({ read: okRead(l) });
    await analyzeImages([await sharpJpeg()], deps);
    expect(references.calls[0]?.q).toEqual({ registrationNumber: 'DR-XY900001' });
  });

  test('not enough clear text: no lookup, not_attempted with a limitation', async () => {
    const l = label([
      field('brandName', 'Paracelin 500', 'partial'),
      field('genericNames', 'Paracetamol', 'unreadable'),
      field('registrationNumber', 'DR-XY900001', 'partial'),
      field('strength', '500 mg'),
    ]);
    const { deps, references } = setup({ read: okRead(l) });
    const result = await analyzeImages([await sharpJpeg()], deps);

    expect(references.calls).toHaveLength(0);
    expect(result.pipelineState).toBe('explanation_ready');
    expect(result.match.status).toBe('not_attempted');
    expect(result.match.limitations).toEqual([NOT_ENOUGH_TEXT]);
  });

  test('a registry that throws is reported as unavailable, not a failed request', async () => {
    const { deps } = setup({ search: new Error('socket hang up') });
    const result = await analyzeImages([await sharpJpeg()], deps);
    expect(result.pipelineState).toBe('explanation_ready');
    expect(result.match.status).toBe('unavailable');
  });

  test('reader failure throws OCR_FAILED and stores nothing', async () => {
    const { deps, store } = setup({
      read: { ok: false, code: 'OCR_FAILED', detail: 'request_failed' },
    });
    await expectPipelineError(analyzeImages([await sharpJpeg()], deps), 'OCR_FAILED');
    expect(store.get('id-1')).toBeUndefined();
  });

  test('bytes that are not an image throw INVALID_IMAGE before the reader runs', async () => {
    const { deps, reader } = setup({});
    await expectPipelineError(
      analyzeImages([await sharpJpeg(), Buffer.from('not an image at all')], deps),
      'INVALID_IMAGE',
    );
    expect(reader.calls).toHaveLength(0);
  });

  test('an upload over 8 MB throws IMAGE_TOO_LARGE', async () => {
    const { deps } = setup({});
    await expectPipelineError(
      analyzeImages([Buffer.alloc(8 * 1024 * 1024 + 1)], deps),
      'IMAGE_TOO_LARGE',
    );
  });

  test('a truncated JPEG that fails to decode throws INVALID_IMAGE', async () => {
    const { deps, reader } = setup({});
    const full = await sharpJpeg();
    await expectPipelineError(analyzeImages([full.subarray(0, 600)], deps), 'INVALID_IMAGE');
    expect(reader.calls).toHaveLength(0);
  });

  test('zero or more than three images throw VALIDATION_FAILED', async () => {
    const { deps } = setup({});
    const img = await sharpJpeg();
    await expectPipelineError(analyzeImages([], deps), 'VALIDATION_FAILED');
    await expectPipelineError(analyzeImages([img, img, img, img], deps), 'VALIDATION_FAILED');
  });

  test('a reader label that breaks the contract throws INTERNAL_ERROR and stores nothing', async () => {
    const bad = label([{ ...field('strength', '500 mg'), key: 'dose' as FieldKey }]);
    const { deps, store } = setup({ read: okRead(bad) });
    await expectPipelineError(analyzeImages([await sharpJpeg()], deps), 'INTERNAL_ERROR');
    expect(store.get('id-1')).toBeUndefined();
  });
});

describe('analyzeScenario', () => {
  class CountingReader extends FixtureLabelReader {
    calls: ProviderContext[] = [];
    override read(images: Buffer[], ctx: ProviderContext): Promise<ReadResult> {
      this.calls.push(ctx);
      return super.read(images, ctx);
    }
  }
  class CountingReferences extends FixtureReferenceProvider {
    calls: ProviderContext[] = [];
    override search(q: ReferenceQuery, ctx: ProviderContext): Promise<ReferenceSearchResult> {
      this.calls.push(ctx);
      return super.search(q, ctx);
    }
  }

  function demoSetup() {
    const reader = new CountingReader();
    const references = new CountingReferences();
    const store = createResultStore(() => T0);
    const deps: PipelineDeps = {
      reader,
      references,
      store,
      now: () => T0,
      newId: () => 'demo-1',
      isDemo: false,
    };
    return { deps, reader, references, store };
  }

  test('s1: fixture providers keyed by scenario id, verified, isDemo true, stored', async () => {
    const { deps, reader, references, store } = demoSetup();
    const result = await analyzeScenario('s1-clear', deps);

    expect(AnalysisResultSchema.parse(result)).toEqual(result);
    expect(result.isDemo).toBe(true);
    expect(result.pipelineState).toBe('explanation_ready');
    expect(result.match.status).toBe('verified');
    expect(result.imageRetention).toBe('none');
    expect(reader.calls).toEqual([{ scenarioId: 's1-clear' }]);
    expect(references.calls).toEqual([{ scenarioId: 's1-clear' }]);
    expect(result.explanation.spokenChunks[0]).toContain('Demo data');
    expect(store.get('demo-1')).toEqual(result);
  });

  test('s2: fixture quality fails, reader never called', async () => {
    const { deps, reader, references } = demoSetup();
    const result = await analyzeScenario('s2-blurry', deps);
    expect(reader.calls).toHaveLength(0);
    expect(references.calls).toHaveLength(0);
    expect(result.pipelineState).toBe('label_unreadable');
    expect(result.label).toBeNull();
    expect(result.quality.reasons).toEqual(['BLURRY', 'GLARE']);
    expect(result.isDemo).toBe(true);
  });

  test('s6: loose pill, registry never called', async () => {
    const { deps, references } = demoSetup();
    const result = await analyzeScenario('s6-loose-pill', deps);
    expect(references.calls).toHaveLength(0);
    expect(result.pipelineState).toBe('loose_pill');
    expect(result.explanation.spokenChunks).toContain(LOOSE_PILL_SENTENCE);
  });

  test('s4, s5, s8 run the real matcher over the fixtures', async () => {
    const statuses: Record<string, string> = {};
    for (const id of ['s4-conflict', 's5-nomatch', 's8-registry-down']) {
      const { deps } = demoSetup();
      statuses[id] = (await analyzeScenario(id, deps)).match.status;
    }
    expect(statuses).toEqual({
      's4-conflict': 'conflicting',
      's5-nomatch': 'no_match',
      's8-registry-down': 'unavailable',
    });
  });

  test('unknown scenario id throws NOT_FOUND', async () => {
    const { deps, reader } = demoSetup();
    await expectPipelineError(analyzeScenario('s99-nope', deps), 'NOT_FOUND');
    expect(reader.calls).toHaveLength(0);
  });
});

describe('final review I2: no transcribed value survives a loose pill, a non-medicine or an unreadable read', () => {
  /** A model that copies a tablet imprint into the fields despite reader rule 7. */
  function filled(imageKind: ExtractedLabel['imageKind']): ExtractedLabel {
    return {
      imageKind,
      fields: [
        { ...field('brandName', 'Paracelin 500'), notes: 'Imprint on the tablet.' },
        field('genericNames', 'Paracetamol'),
        field('strength', '500 mg'),
        field('dosageForm', 'Tablet'),
      ],
      rawText: 'PARACELIN 500 imprint',
      warnings: ['DEMO DATA photo note'],
    };
  }

  test.each([
    ['loose_pill', 'loose_pill'],
    ['not_medicine', 'not_a_label'],
    ['unreadable', 'label_unreadable'],
  ] as const)(
    '%s: every field value, evidence and note is null and unreadable',
    async (kind, state) => {
      const { deps, references, store } = setup({ read: okRead(filled(kind)) });
      const result = await analyzeImages([await sharpJpeg()], deps);

      expect(references.calls).toHaveLength(0);
      expect(result.pipelineState).toBe(state);
      expect(result.label?.imageKind).toBe(kind);
      expect(result.label?.rawText).toBe('');
      expect(result.label?.warnings).toEqual(['DEMO DATA photo note']);
      expect(result.label?.fields.map((f) => f.key)).toEqual([
        'brandName',
        'genericNames',
        'strength',
        'dosageForm',
      ]);
      for (const f of result.label?.fields ?? []) {
        expect(f).toEqual({
          key: f.key,
          value: null,
          legibility: 'unreadable',
          evidenceText: null,
          imageIndex: null,
          notes: null,
        });
      }
      expect(JSON.stringify(store.get(result.id))).not.toMatch(/Paracelin|Paracetamol|500 mg/);
      expect(result.explanation.displayText).not.toMatch(/Paracelin|Paracetamol|500 mg/);
    },
  );

  test('a label read keeps its values', async () => {
    const { deps } = setup({});
    const result = await analyzeImages([await sharpJpeg()], deps);
    expect(result.label).toEqual(PARACELIN);
  });
});

describe('final review Minor 15: the result store holds at most maxEntries, oldest first out', () => {
  function result(id: string) {
    return AnalysisResultSchema.parse({
      id,
      isDemo: true,
      createdAt: new Date(T0).toISOString(),
      expiresAt: new Date(T0 + FIFTEEN_MIN).toISOString(),
      pipelineState: 'label_unreadable',
      quality: { ok: false, sharpness: 1, luminance: 100, glareFraction: 0, reasons: ['BLURRY'] },
      label: null,
      match: {
        status: 'not_attempted',
        matched: [],
        conflicting: [],
        missing: [],
        candidates: [],
        advisories: [],
        limitations: [],
      },
      explanation: { displayText: '', spokenChunks: [], safetyNotices: [], supportingFields: [] },
      imageRetention: 'none',
    });
  }

  test('the default cap is MAX_CACHE_ENTRIES (500): the 501st result evicts the first', () => {
    const store = createResultStore(() => T0);
    for (let i = 0; i <= MAX_CACHE_ENTRIES; i++) store.put(result(`r${i}`));
    expect(store.size).toBe(MAX_CACHE_ENTRIES);
    expect(store.get('r0')).toBeUndefined();
    expect(store.get('r1')).toBeDefined();
    expect(store.get(`r${MAX_CACHE_ENTRIES}`)).toBeDefined();
  });

  test('a custom cap evicts the oldest result first', () => {
    const store = createResultStore(() => T0, FIFTEEN_MIN, 2);
    store.put(result('a'));
    store.put(result('b'));
    store.put(result('c'));
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeDefined();
    expect(store.get('c')).toBeDefined();
  });

  test('expired results are swept before a live one is evicted', () => {
    let clock = T0;
    const store = createResultStore(() => clock, 1000, 2);
    store.put(result('old'));
    clock += 500;
    store.put(result('live'));
    clock += 500; // 'old' has expired
    store.put(result('new'));
    expect(store.get('live')).toBeDefined();
    expect(store.get('new')).toBeDefined();
  });
});
