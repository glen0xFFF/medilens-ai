import type { ExtractedLabel, FieldKey, Legibility } from '@medilens/contracts';
import { describe, expect, it } from 'vitest';
import {
  GroundTruthSchema,
  SCORED_FIELDS,
  parseMonthYear,
  renderResultsMarkdown,
  scoreLabel,
  summarize,
  type GroundTruth,
} from '../../src/eval/score';

const truth: GroundTruth = {
  packId: 'pack-01',
  images: ['front.jpg'],
  brandName: 'Biogesic',
  genericNames: ['Paracetamol'],
  strength: '500 mg',
  dosageForm: 'Tablet',
  registrationNumber: 'DR-XY12345',
  expiryDate: '2027-03',
};

type Read = { value: string | null; legibility: Legibility };

function label(overrides: Partial<Record<FieldKey, Read>> = {}): ExtractedLabel {
  const base: Partial<Record<FieldKey, Read>> = {
    brandName: { value: 'BIOGESIC®', legibility: 'clear' },
    genericNames: { value: 'Paracetamol', legibility: 'clear' },
    strength: { value: '500 mg', legibility: 'clear' },
    dosageForm: { value: 'tablet', legibility: 'clear' },
    registrationNumber: { value: 'DR-XY 12345', legibility: 'clear' },
    expiryDate: { value: 'EXP 03/2027', legibility: 'clear' },
    ...overrides,
  };
  return {
    imageKind: 'label',
    fields: Object.entries(base).map(([key, r]) => ({
      key: key as FieldKey,
      value: r.value,
      legibility: r.legibility,
      evidenceText: r.value,
      imageIndex: 0,
      notes: null,
    })),
    rawText: '',
    warnings: [],
  };
}

function field(results: ReturnType<typeof scoreLabel>, key: FieldKey) {
  const r = results.find((x) => x.field === key);
  if (!r) throw new Error(`no result for ${key}`);
  return r;
}

const read = (value: string | null, legibility: Legibility = 'clear'): Read => ({
  value,
  legibility,
});

describe('scoreLabel', () => {
  it('scores every scored field once, all correct for a faithful read', () => {
    const results = scoreLabel(truth, label());
    expect(results.map((r) => r.field)).toEqual([...SCORED_FIELDS]);
    expect(results.every((r) => r.correct && !r.confidentlyWrong)).toBe(true);
  });

  it('marks a wrong strength read as clear as confidently wrong', () => {
    const r = field(scoreLabel(truth, label({ strength: read('250 mg') })), 'strength');
    expect(r).toEqual({
      field: 'strength',
      correct: false,
      legibility: 'clear',
      confidentlyWrong: true,
    });
  });

  it('does not mark a wrong strength read as partial as confidently wrong', () => {
    const r = field(scoreLabel(truth, label({ strength: read('250 mg', 'partial') })), 'strength');
    expect(r.correct).toBe(false);
    expect(r.confidentlyWrong).toBe(false);
  });

  it('never marks an unreadable field as confidently wrong', () => {
    const r = field(
      scoreLabel(truth, label({ strength: read('250 mg', 'unreadable') })),
      'strength',
    );
    expect(r.correct).toBe(false);
    expect(r.confidentlyWrong).toBe(false);
  });

  it('treats 1 g and 1000 mg as the same strength', () => {
    const r = field(
      scoreLabel({ ...truth, strength: '1 g' }, label({ strength: read('1000 mg') })),
      'strength',
    );
    expect(r.correct).toBe(true);
  });

  it('counts an unparseable strength read as incorrect', () => {
    const r = field(scoreLabel(truth, label({ strength: read('5OO mg') })), 'strength');
    expect(r.correct).toBe(false);
    expect(r.confidentlyWrong).toBe(true);
  });

  it('compares expiry by month and year: EXP 03/2027 equals 2027-03', () => {
    const r = field(scoreLabel(truth, label({ expiryDate: read('EXP 03/2027') })), 'expiryDate');
    expect(r.correct).toBe(true);
  });

  it('flags a wrong clear expiry as confidently wrong', () => {
    const r = field(scoreLabel(truth, label({ expiryDate: read('04/2027') })), 'expiryDate');
    expect(r.confidentlyWrong).toBe(true);
  });

  it('accepts a null truth when the read is null or unreadable', () => {
    const t = { ...truth, expiryDate: null, registrationNumber: null };
    const nullRead = scoreLabel(t, label({ expiryDate: read(null) }));
    expect(field(nullRead, 'expiryDate').correct).toBe(true);
    const unreadable = scoreLabel(t, label({ registrationNumber: read('DR-?', 'unreadable') }));
    expect(field(unreadable, 'registrationNumber').correct).toBe(true);
    const invented = scoreLabel(t, label({ expiryDate: read('03/2027') }));
    expect(field(invented, 'expiryDate')).toMatchObject({ correct: false, confidentlyWrong: true });
  });

  it('treats a field missing from the read as unreadable, never confidently wrong', () => {
    const l = label();
    l.fields = l.fields.filter((f) => f.key !== 'brandName');
    const r = field(scoreLabel(truth, l), 'brandName');
    expect(r).toEqual({
      field: 'brandName',
      correct: false,
      legibility: 'unreadable',
      confidentlyWrong: false,
    });
  });

  it('compares generic names as a set of normalized names', () => {
    const t = { ...truth, genericNames: ['Amoxicillin', 'Clavulanic Acid'] };
    const ok = scoreLabel(t, label({ genericNames: read('clavulanic acid + AMOXICILLIN') }));
    expect(field(ok, 'genericNames').correct).toBe(true);
    const short = scoreLabel(t, label({ genericNames: read('Amoxicillin') }));
    expect(field(short, 'genericNames').correct).toBe(false);
  });

  it('normalizes registration numbers and names before comparing', () => {
    const results = scoreLabel(
      truth,
      label({
        registrationNumber: read('dr-xy12345'),
        brandName: read('Biogesic Tablet'),
        dosageForm: read('Film-coated tablets'),
      }),
    );
    expect(field(results, 'registrationNumber').correct).toBe(true);
    expect(field(results, 'brandName').correct).toBe(true);
    expect(field(results, 'dosageForm').correct).toBe(true);
  });

  it('scores a different dosage form as incorrect (form words are not dropped)', () => {
    const capsule = scoreLabel(truth, label({ dosageForm: read('Capsule') }));
    expect(field(capsule, 'dosageForm')).toMatchObject({ correct: false, confidentlyWrong: true });
    const t = { ...truth, dosageForm: 'Eye drops' };
    const ear = scoreLabel(t, label({ dosageForm: read('Ear Drops') }));
    expect(field(ear, 'dosageForm').correct).toBe(false);
    const eye = scoreLabel(t, label({ dosageForm: read('eye drop') }));
    expect(field(eye, 'dosageForm').correct).toBe(true);
  });
});

describe('parseMonthYear', () => {
  it.each([
    ['03/2027', { month: 3, year: 2027 }],
    ['3-2027', { month: 3, year: 2027 }],
    ['2027-03', { month: 3, year: 2027 }],
    ['MAR 2027', { month: 3, year: 2027 }],
    ['Exp. Mar 2027', { month: 3, year: 2027 }],
    ['EXP: 12/2026', { month: 12, year: 2026 }],
  ])('parses %s', (input, expected) => {
    expect(parseMonthYear(input)).toEqual(expected);
  });

  it.each(['13/2027', '2027', 'March', '03/27', 'MAR 2027 03/2028'])('rejects %s', (input) => {
    expect(parseMonthYear(input)).toBeNull();
  });
});

describe('GroundTruthSchema', () => {
  it('accepts a valid truth file and rejects an unparseable strength or no images', () => {
    expect(GroundTruthSchema.safeParse(truth).success).toBe(true);
    expect(GroundTruthSchema.safeParse({ ...truth, strength: 'five hundred' }).success).toBe(false);
    expect(GroundTruthSchema.safeParse({ ...truth, images: [] }).success).toBe(false);
  });

  it('rejects an expiryDate parseMonthYear cannot read, and still accepts null', () => {
    const bad = GroundTruthSchema.safeParse({ ...truth, expiryDate: '03.2027' });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.path).toEqual(['expiryDate']);
    expect(GroundTruthSchema.safeParse({ ...truth, expiryDate: 'EXP 03/2027' }).success).toBe(true);
    expect(GroundTruthSchema.safeParse({ ...truth, expiryDate: null }).success).toBe(true);
  });

  it('rejects a registrationNumber normalizeRegistrationNumber rejects, and still accepts null', () => {
    const bad = GroundTruthSchema.safeParse({ ...truth, registrationNumber: 'FR-123' });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.path).toEqual(['registrationNumber']);
    expect(GroundTruthSchema.safeParse({ ...truth, registrationNumber: null }).success).toBe(true);
  });
});

describe('summarize and renderResultsMarkdown', () => {
  it('aggregates counts per field and renders no pack ids or values', () => {
    const a = scoreLabel(truth, label({ strength: read('250 mg') }));
    const b = scoreLabel(truth, label({ expiryDate: read(null, 'unreadable') }));
    const summary = summarize([a, b]);
    expect(summary.packs).toBe(2);
    expect(summary.fields.find((f) => f.field === 'strength')).toEqual({
      field: 'strength',
      total: 2,
      correct: 1,
      unreadable: 0,
      confidentlyWrong: 1,
    });
    expect(summary.fields.find((f) => f.field === 'expiryDate')).toMatchObject({
      correct: 1,
      unreadable: 1,
    });
    const md = renderResultsMarkdown(summary, '2026-10-30', { found: 2, attempted: 2, skipped: 0 });
    expect(md).toContain('| strength | 2 | 1 | 0 | 1 |');
    expect(md).not.toContain('pack-01');
    expect(md).not.toContain('250');
  });
});

describe('final review Minor 31: eval results count every pack, not only the scored ones', () => {
  it('records packs found, attempted, scored and skipped, and flags a run that is not clean', () => {
    const summary = summarize([scoreLabel(truth, label())]);
    const md = renderResultsMarkdown(summary, '2026-10-30', { found: 4, attempted: 3, skipped: 2 });
    expect(md).toContain(
      'Packs found: 4. Attempted: 3. Scored: 1. Skipped: 2. Not attempted (spend cap): 1.',
    );
    expect(md).toContain('Not a clean run');
  });

  it('a run that scored every pack it found is clean', () => {
    const summary = summarize([scoreLabel(truth, label())]);
    const md = renderResultsMarkdown(summary, '2026-10-30', { found: 1, attempted: 1, skipped: 0 });
    expect(md).toContain(
      'Packs found: 1. Attempted: 1. Scored: 1. Skipped: 0. Not attempted (spend cap): 0.',
    );
    expect(md).not.toContain('Not a clean run');
  });
});
