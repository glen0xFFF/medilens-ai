import {
  MatchAssessmentSchema,
  type ExtractedLabel,
  type FieldKey,
  type Legibility,
  type MatchAssessment,
  type ReferenceRecord,
} from '@medilens/contracts';
import { describe, expect, test } from 'vitest';
import { assessMatch } from '../../src/domain/matcher';
import type { ReferenceSearchResult } from '../../src/providers/types';

const EXPIRY_NOTE = "Registration expiry is not the product's expiry date.";
const UNAVAILABLE_NOTE = 'Registry lookup unavailable; nothing was verified.';
const NOT_ATTEMPTED_NOTE = 'Registry lookup was not attempted.';
const REG_NOT_FOUND_NOTE = 'The registration number on the pack was not found in the registry.';

type FieldSpec = string | [value: string | null, legibility: Legibility];

function label(fields: Partial<Record<FieldKey, FieldSpec>>): ExtractedLabel {
  return {
    imageKind: 'label',
    fields: Object.entries(fields).map(([key, spec]) => {
      const [value, legibility] = typeof spec === 'string' ? [spec, 'clear' as const] : spec;
      return {
        key: key as FieldKey,
        value,
        legibility,
        evidenceText: value,
        imageIndex: 0,
        notes: null,
      };
    }),
    rawText: '',
    warnings: [],
  };
}

function record(overrides: Partial<ReferenceRecord> = {}): ReferenceRecord {
  return {
    provider: 'test',
    sourceUrl: 'https://verification.fda.gov.ph/test',
    registrationNumber: 'DR-XY12345',
    brandName: 'Biogesic',
    genericName: 'Paracetamol',
    strengthForm: '500 mg Tablet',
    manufacturer: 'Unilab',
    classification: 'OTC',
    registrationExpiry: '2030-01-01',
    checkedAt: '2026-10-27T00:00:00.000Z',
    ...overrides,
  };
}

const ADVISORY = { title: 'FDA Advisory No. 2026-001', url: 'https://www.fda.gov.ph/advisory-1' };

function ok(
  records: ReferenceRecord[],
  advisories: { title: string; url: string }[] = [],
): ReferenceSearchResult {
  return { kind: 'ok', records, advisories };
}

function assess(l: ExtractedLabel, s: ReferenceSearchResult): MatchAssessment {
  const result = assessMatch(l, s);
  // Every result must satisfy the shared contract.
  expect(MatchAssessmentSchema.parse(result)).toEqual(result);
  return result;
}

const fullLabel = (overrides: Partial<Record<FieldKey, FieldSpec>> = {}) =>
  label({
    registrationNumber: 'DR-XY12345',
    brandName: 'Biogesic',
    strength: '500 mg',
    ...overrides,
  });

describe('assessMatch', () => {
  test('rule 1+3: exact reg no, brand and strength clear and agreeing -> verified', () => {
    const r = record();
    const result = assess(fullLabel(), ok([r]));
    expect(result.status).toBe('verified');
    expect(result.matched).toEqual(
      expect.arrayContaining(['registrationNumber', 'brandName', 'strength']),
    );
    expect(result.conflicting).toEqual([]);
    expect(result.candidates).toEqual([r]);
  });

  test('rule 3+10: same but strength legibility partial -> partial, not verified', () => {
    const result = assess(fullLabel({ strength: ['500 mg', 'partial'] }), ok([record()]));
    expect(result.status).toBe('partial');
    expect(result.matched).not.toContain('strength');
    expect(result.missing).toContain('strength');
  });

  test('rule 1+4: reg no partial -> partial (brand and strength still match)', () => {
    const result = assess(
      fullLabel({ registrationNumber: ['DR-XY12345', 'partial'] }),
      ok([record()]),
    );
    expect(result.status).toBe('partial');
    expect(result.matched).not.toContain('registrationNumber');
    expect(result.missing).toContain('registrationNumber');
    expect(result.matched).toEqual(expect.arrayContaining(['brandName', 'strength']));
  });

  test('rule 3: registry strength-form with no form word -> form missing, still verified', () => {
    const result = assess(
      fullLabel({ dosageForm: 'Tablet' }),
      ok([record({ strengthForm: '500 mg' })]),
    );
    expect(result.status).toBe('verified');
    expect(result.missing).toContain('dosageForm');
    expect(result.matched).not.toContain('dosageForm');
  });

  test('rule 4: brand-only match without strength -> no_match', () => {
    const result = assess(label({ brandName: 'Biogesic' }), ok([record()]));
    expect(result.status).toBe('no_match');
    expect(result.candidates).toEqual([]);
    expect(result.matched).toEqual([]);
  });

  test('rule 6: conflict with a reg-no match -> conflicting', () => {
    const result = assess(fullLabel(), ok([record({ strengthForm: '250 mg Tablet' })]));
    expect(result.status).toBe('conflicting');
    expect(result.conflicting).toEqual([
      { key: 'strength', labelValue: '500 mg', referenceValue: '250 mg Tablet' },
    ]);
    expect(result.candidates).toHaveLength(1);
  });

  test('rule 6: strength 500 vs 250 -> conflicting with the original strings', () => {
    const result = assess(
      label({ brandName: 'Biogesic', strength: '500 mg' }),
      ok([record({ strengthForm: '250 mg' })]),
    );
    expect(result.status).toBe('conflicting');
    expect(result.conflicting).toEqual([
      { key: 'strength', labelValue: '500 mg', referenceValue: '250 mg' },
    ]);
  });

  test('rule 7: two equal candidates -> ambiguous with both listed', () => {
    const a = record({ registrationNumber: 'DR-XY11111' });
    const b = record({ registrationNumber: 'DR-XY22222', manufacturer: 'Other Labs' });
    const result = assess(label({ brandName: 'Biogesic', strength: '500 mg' }), ok([a, b]));
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toEqual([a, b]);
    expect(result.conflicting).toEqual([]);
  });

  test('rule 8: zero records -> no_match', () => {
    const result = assess(fullLabel(), ok([]));
    expect(result.status).toBe('no_match');
    expect(result.candidates).toEqual([]);
    expect(result.limitations).not.toContain(EXPIRY_NOTE);
  });

  test('rule 9: unavailable input -> unavailable + limitation', () => {
    const result = assess(fullLabel(), { kind: 'unavailable', reason: 'timeout' });
    expect(result.status).toBe('unavailable');
    expect(result.limitations).toContain(UNAVAILABLE_NOTE);
    expect(result.candidates).toEqual([]);
    expect(result.matched).toEqual([]);
  });

  test('not_attempted input -> not_attempted + limitation', () => {
    const result = assess(fullLabel(), { kind: 'not_attempted' });
    expect(result.status).toBe('not_attempted');
    expect(result.limitations).toContain(NOT_ATTEMPTED_NOTE);
    expect(result.candidates).toEqual([]);
  });

  test('rule 10: strength legibility partial and value equal -> strength NOT matched', () => {
    const result = assess(
      label({ brandName: 'Biogesic', strength: ['500 mg', 'partial'] }),
      ok([record()]),
    );
    expect(result.matched).not.toContain('strength');
    expect(result.missing).toContain('strength');
    expect(result.status).not.toBe('verified');
    expect(result.status).not.toBe('partial');
  });

  test('rule 10: an unclear field never produces a conflict either', () => {
    const result = assess(fullLabel({ strength: ['250 mg', 'partial'] }), ok([record()]));
    expect(result.conflicting).toEqual([]);
    expect(result.missing).toContain('strength');
  });

  test('rule 11: advisory on a verified record -> still verified, advisory passed through', () => {
    const result = assess(fullLabel(), ok([record()], [ADVISORY]));
    expect(result.status).toBe('verified');
    expect(result.advisories).toEqual([ADVISORY]);
  });

  test('rule 11: advisories that could not be checked add a limitation, for any ok status', () => {
    const unchecked: ReferenceSearchResult = {
      kind: 'ok',
      records: [record()],
      advisories: [],
      advisoriesUnchecked: true,
    };
    const result = assess(fullLabel(), unchecked);
    expect(result.limitations).toContain(
      'FDA safety advisories for this product could not be checked.',
    );
    const none = assess(fullLabel(), { ...unchecked, records: [] });
    expect(none.limitations).toContain('FDA safety advisories for this product could not be checked.');
    expect(assess(fullLabel(), ok([record()])).limitations).not.toContain(
      'FDA safety advisories for this product could not be checked.',
    );
  });

  test('rule 11: advisories pass through unchanged for any status', () => {
    expect(assess(fullLabel(), ok([], [ADVISORY])).advisories).toEqual([ADVISORY]);
    expect(
      assess(fullLabel(), ok([record({ strengthForm: '250 mg' })], [ADVISORY])).advisories,
    ).toEqual([ADVISORY]);
  });

  test.each<[string, ReferenceSearchResult]>([
    ['verified', ok([record()])],
    ['conflicting', ok([record({ strengthForm: '250 mg' })])],
    [
      'ambiguous',
      ok([
        record({ registrationNumber: 'DR-XY11111' }),
        record({ registrationNumber: 'DR-XY22222' }),
      ]),
    ],
  ])('limitations carry the expiry note whenever a record is shown (%s)', (_, search) => {
    const l =
      search.kind === 'ok' && search.records.length > 1
        ? label({ brandName: 'Biogesic', strength: '500 mg' })
        : fullLabel();
    const result = assess(l, search);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.limitations).toContain(EXPIRY_NOTE);
  });
});

describe('assessMatch: comparison details', () => {
  test('rule 1: brand disagreement on the reg-no record is a conflict', () => {
    const result = assess(fullLabel(), ok([record({ brandName: 'Tempra' })]));
    expect(result.status).toBe('conflicting');
    expect(result.conflicting).toEqual([
      { key: 'brandName', labelValue: 'Biogesic', referenceValue: 'Tempra' },
    ]);
  });

  test('rule 2: a fitting record wins over a conflicting record of the same brand', () => {
    const tablet = record({ registrationNumber: 'DR-XY11111' });
    const syrup = record({
      registrationNumber: 'DR-XY22222',
      strengthForm: '250 mg/5 mL Suspension',
    });
    const result = assess(
      label({ brandName: 'Biogesic', strength: '500 mg' }),
      ok([syrup, tablet]),
    );
    expect(result.status).toBe('partial');
    expect(result.candidates).toEqual([tablet]);
  });

  test('rule 2: a record of a different brand with the same generic is not a candidate', () => {
    const result = assess(
      label({ brandName: 'Biogesic', genericNames: 'Paracetamol', strength: '500 mg' }),
      ok([record({ brandName: 'Tempra' })]),
    );
    expect(result.status).toBe('no_match');
    expect(result.conflicting).toEqual([]);
  });

  test('rule 4: generic plus strength without a brand -> partial', () => {
    const result = assess(
      label({ genericNames: 'Paracetamol', strength: '500 mg' }),
      ok([record()]),
    );
    expect(result.status).toBe('partial');
    expect(result.matched).toEqual(expect.arrayContaining(['genericNames', 'strength']));
  });

  test('rule 6: a weak fit does not hide a conflicting record', () => {
    const noStrength = record({ registrationNumber: 'DR-XY11111', strengthForm: null });
    const wrong = record({ registrationNumber: 'DR-XY22222', strengthForm: '250 mg Tablet' });
    const result = assess(
      label({ brandName: 'Biogesic', strength: '500 mg' }),
      ok([noStrength, wrong]),
    );
    expect(result.status).toBe('conflicting');
    expect(result.candidates).toEqual([wrong]);
  });

  test('rule 6: a tie of weak fits does not hide a conflicting record either', () => {
    const weakA = record({ registrationNumber: 'DR-XY11111', strengthForm: null });
    const weakB = record({ registrationNumber: 'DR-XY22222', strengthForm: null });
    const wrong = record({ registrationNumber: 'DR-XY33333', strengthForm: '250 mg Tablet' });
    const result = assess(
      label({ brandName: 'Biogesic', strength: '500 mg' }),
      ok([weakA, weakB, wrong]),
    );
    expect(result.status).toBe('conflicting');
    expect(result.candidates).toEqual([wrong]);
  });

  test('unparseable registry strength is missing, never matched or conflicting', () => {
    const result = assess(fullLabel(), ok([record({ strengthForm: 'See package insert' })]));
    expect(result.status).toBe('partial');
    expect(result.missing).toContain('strength');
    expect(result.conflicting).toEqual([]);
  });

  test('unparseable label strength is missing, never matched or conflicting', () => {
    const result = assess(
      fullLabel({ strength: '10x1~2 mg' }),
      ok([record({ strengthForm: '2 mg' })]),
    );
    expect(result.matched).not.toContain('strength');
    expect(result.missing).toContain('strength');
    expect(result.conflicting).toEqual([]);
    expect(result.status).toBe('partial');
  });

  test('concentration strength with a form word parses from strengthForm', () => {
    const result = assess(
      label({
        registrationNumber: 'DR-XY12345',
        brandName: 'Biogesic',
        strength: '250 mg/5 mL',
        dosageForm: 'Suspension',
      }),
      ok([record({ strengthForm: '250 mg/5 mL Suspension' })]),
    );
    expect(result.status).toBe('verified');
    expect(result.matched).toEqual(expect.arrayContaining(['strength', 'dosageForm']));
  });

  test.each([
    ['Tablets', '500 mg Tablet'],
    ['Film-Coated Tablet', '500 mg Tablet'],
    ['tablet', '500 mg Film-Coated Tablets'],
  ])('dosage form %s matches %s', (form, strengthForm) => {
    const result = assess(fullLabel({ dosageForm: form }), ok([record({ strengthForm })]));
    expect(result.status).toBe('verified');
    expect(result.matched).toContain('dosageForm');
  });

  test('dosage form disagreement is a conflict', () => {
    const result = assess(fullLabel({ dosageForm: 'Capsule' }), ok([record()]));
    expect(result.status).toBe('conflicting');
    expect(result.conflicting).toEqual([
      { key: 'dosageForm', labelValue: 'Capsule', referenceValue: '500 mg Tablet' },
    ]);
  });

  test('label dosage form with no recognisable form word is missing and blocks verified', () => {
    const result = assess(fullLabel({ dosageForm: 'Oral' }), ok([record()]));
    expect(result.status).toBe('partial');
    expect(result.missing).toContain('dosageForm');
  });

  test.each([
    'Suppository',
    'Gel',
    'Eye Drop',
    'Eye Drops',
    'Drops',
    'Lozenge',
    'Sachet',
    'Spray',
    'Powder',
    'Granules',
    'Lotion',
    'Softgel',
    'Elixir',
    'Patch',
    'Inhaler',
  ])('label form %s against registry 500 mg Tablet is a conflict', (form) => {
    const result = assess(fullLabel({ dosageForm: form }), ok([record()]));
    expect(result.status).toBe('conflicting');
    expect(result.conflicting).toEqual([
      { key: 'dosageForm', labelValue: form, referenceValue: '500 mg Tablet' },
    ]);
  });

  test.each([
    '500 mg Suppository',
    '500 mg Granules',
    '500 mg Gel',
    '500 mg Oral Drops',
    '500 mg Softgel',
    '500 mg Powder',
    '500 mg Lozenge',
  ])('label form Tablet against registry %s is a conflict', (strengthForm) => {
    const result = assess(fullLabel({ dosageForm: 'Tablet' }), ok([record({ strengthForm })]));
    expect(result.status).toBe('conflicting');
    expect(result.conflicting.map((c) => c.key)).toEqual(['dosageForm']);
  });

  test.each([
    ['Effervescent Tablet', '500 mg Tablet'],
    ['Pessary', '500 mg Tablet'],
    ['Tablet', '500 mg Pessary'],
    ['Tablet', '500 mg Chewable Tablet'],
    // A word mixing letters and digits that is not a pure strength is unrecognised, never dropped.
    ['Tablet', '500mgTablet'],
    ['Tablet', '500 mg Tablet-1s'],
    ['Tablet', '500 mg Tablets (10s)'],
    ['Tablet', '500 mg Capsule500'],
    ['Tablet500', '500 mg Tablet'],
    // A format character is never stripped silently.
    ['Tablet\u200b', '500 mg Tablet'],
    ['Tab\u00adlet', '500 mg Tablet'],
  ])('unrecognised form text (label %s, registry %s) caps the status at partial', (form, sf) => {
    const result = assess(fullLabel({ dosageForm: form }), ok([record({ strengthForm: sf })]));
    expect(result.status).toBe('partial');
    expect(result.missing).toContain('dosageForm');
    expect(result.conflicting).toEqual([]);
  });

  test.each([
    ['Tablet', '500mg-Capsule', '500 mg'],
    ['Syrup', '250mg/5mL-Suspension', '250 mg/5 mL'],
    ['Tablet', 'Suppository-500mg', '500 mg'],
    ['Tablet', '500mg-Suppository', '500 mg'],
  ])(
    'a form glued to the strength is still read: label %s vs %s -> conflicting',
    (form, sf, st) => {
      const result = assess(
        fullLabel({ dosageForm: form, strength: st }),
        ok([record({ strengthForm: sf })]),
      );
      expect(result.status).toBe('conflicting');
      expect(result.conflicting.map((c) => c.key)).toEqual(['dosageForm']);
    },
  );

  test.each([
    ['Tablet', '500mg-Tablet'],
    ['Tablet', '500 mg Film Coated Tablet'],
    ['Tablet', '500 mg Film–Coated Tablet'],
    ['Tablet', '500 mg Film—Coated Tablet'],
    ['Film Coated Tablet', '500 mg Tablet'],
    ['Film—Coated Tablets', '500 mg Tablet'],
  ])('label %s matches registry %s', (form, sf) => {
    const result = assess(fullLabel({ dosageForm: form }), ok([record({ strengthForm: sf })]));
    expect(result.status).toBe('verified');
    expect(result.matched).toContain('dosageForm');
  });

  test('rule 1: an unconfirmable record under the same number caps the status at partial', () => {
    const result = assess(
      fullLabel({ dosageForm: 'Tablet' }),
      ok([record(), record({ strengthForm: '500 mg Chewable Tablet' })]),
    );
    expect(result.status).toBe('partial');
  });

  test.each<[string, Partial<ReferenceRecord>]>([
    ['unparseable strength', { strengthForm: 'See package insert Tablet' }],
    ['missing brand', { brandName: null }],
  ])('rule 1: a sibling with %s caps the status at partial', (_, sibling) => {
    const result = assess(fullLabel(), ok([record(), record(sibling)]));
    expect(result.status).toBe('partial');
  });

  test('a stated label form that is not clear caps the status at partial', () => {
    const result = assess(fullLabel({ dosageForm: ['Tablet', 'partial'] }), ok([record()]));
    expect(result.status).toBe('partial');
    expect(result.missing).toContain('dosageForm');
  });

  test.each([
    ['Eye Drops', '0.5% Eye Drops', 'verified'],
    ['Ear Drops', '0.5% Eye Drops', 'conflicting'],
    ['Eye Drops', '0.5% Drops', 'conflicting'],
  ])('qualified drops: label %s vs registry %s -> %s', (form, strengthForm, status) => {
    const result = assess(
      fullLabel({ dosageForm: form, strength: '0.5%' }),
      ok([record({ strengthForm })]),
    );
    expect(result.status).toBe(status);
  });

  test('registry text with no form text leaves verified reachable (rule 3)', () => {
    const result = assess(
      fullLabel({ dosageForm: 'Suppository' }),
      ok([record({ strengthForm: '500 mg' })]),
    );
    expect(result.status).toBe('verified');
    expect(result.missing).toContain('dosageForm');
  });

  test('rule 1+6: a conflicting record under the same registration number is not hidden', () => {
    const fits = record();
    const otherBrand = record({ brandName: 'Tempra' });
    const otherStrength = record({ strengthForm: '250 mg Tablet' });
    const result = assess(fullLabel(), ok([fits, otherBrand, otherStrength]));
    expect(result.status).toBe('conflicting');
    expect(result.conflicting).toEqual([
      { key: 'brandName', labelValue: 'Biogesic', referenceValue: 'Tempra' },
      { key: 'strength', labelValue: '500 mg', referenceValue: '250 mg Tablet' },
    ]);
    expect(result.candidates).toEqual(expect.arrayContaining([otherBrand, otherStrength]));
    expect(result.limitations).toContain(EXPIRY_NOTE);
  });

  test('rule 1+6: a form-conflicting sibling under the same registration number', () => {
    const result = assess(
      fullLabel({ dosageForm: 'Tablet' }),
      ok([record(), record({ strengthForm: '500 mg Capsule' })]),
    );
    expect(result.status).toBe('conflicting');
    expect(result.conflicting.map((c) => c.key)).toEqual(['dosageForm']);
  });

  test('rule 2: a fitting record still beats a conflicting one found by name', () => {
    const fits = record({ registrationNumber: 'DR-XY11111' });
    const other = record({ registrationNumber: 'DR-XY22222', strengthForm: '250 mg Tablet' });
    const result = assess(label({ brandName: 'Biogesic', strength: '500 mg' }), ok([other, fits]));
    expect(result.status).toBe('partial');
    expect(result.candidates).toEqual([fits]);
  });

  test.each([
    ['Paracetamol + Caffeine', 'Caffeine, Paracetamol'],
    ['Paracetamol and Caffeine', 'Caffeine + Paracetamol'],
    ['PARACETAMOL', 'Paracetamol'],
  ])('generic names %s match %s as a set', (labelGeneric, registryGeneric) => {
    const result = assess(
      fullLabel({ genericNames: labelGeneric }),
      ok([record({ genericName: registryGeneric })]),
    );
    expect(result.matched).toContain('genericNames');
  });

  test('generic name sets that differ conflict', () => {
    const result = assess(
      fullLabel({ genericNames: 'Paracetamol' }),
      ok([record({ genericName: 'Paracetamol + Caffeine' })]),
    );
    expect(result.status).toBe('conflicting');
    expect(result.conflicting).toEqual([
      { key: 'genericNames', labelValue: 'Paracetamol', referenceValue: 'Paracetamol + Caffeine' },
    ]);
  });

  test.each([
    ['Biogesic', 'BIOGESIC®'],
    ['Biogesic Tablet', 'Biogesic'],
    ['Neozep', 'Neozep Forte'],
  ])('brand %s matches %s', (labelBrand, registryBrand) => {
    const result = assess(
      fullLabel({ brandName: labelBrand }),
      ok([record({ brandName: registryBrand })]),
    );
    expect(result.matched).toContain('brandName');
  });

  test('brand containment must be on whole words', () => {
    const result = assess(fullLabel({ brandName: 'Bio' }), ok([record()]));
    expect(result.matched).not.toContain('brandName');
    expect(result.status).toBe('conflicting');
  });

  test('a clear reg no that is not in the records is missing and caps the status at partial', () => {
    const result = assess(fullLabel({ registrationNumber: 'DR-XY99999' }), ok([record()]));
    expect(result.status).toBe('partial');
    expect(result.missing).toContain('registrationNumber');
    expect(result.limitations).toContain(REG_NOT_FOUND_NOTE);
  });

  test('the reg-not-found note also applies to a rule 2 no_match', () => {
    const result = assess(fullLabel({ registrationNumber: 'DR-XY99999' }), ok([]));
    expect(result.status).toBe('no_match');
    expect(result.limitations).toEqual([REG_NOT_FOUND_NOTE]);
  });

  test.each<[string, FieldSpec | undefined]>([
    ['found by number', 'DR-XY12345'],
    ['not clear', ['DR-XY99999', 'partial']],
    ['absent', undefined],
  ])('no reg-not-found note when the number is %s', (_, reg) => {
    const l =
      reg === undefined
        ? label({ brandName: 'Biogesic', strength: '500 mg' })
        : fullLabel({ registrationNumber: reg });
    const result = assess(l, ok([record()]));
    expect(result.limitations).not.toContain(REG_NOT_FOUND_NOTE);
  });

  test('registration numbers compare after normalisation', () => {
    const result = assess(fullLabel({ registrationNumber: 'dr-xy 12345' }), ok([record()]));
    expect(result.status).toBe('verified');
  });

  test('a field that is absent from the label is missing', () => {
    const result = assess(fullLabel(), ok([record()]));
    expect(result.missing).toEqual(expect.arrayContaining(['genericNames', 'dosageForm']));
  });

  test('a duplicated label field is not comparable', () => {
    const l = fullLabel();
    l.fields.push({ ...l.fields.find((f) => f.key === 'strength')!, value: '250 mg' });
    const result = assess(l, ok([record()]));
    expect(result.matched).not.toContain('strength');
    expect(result.status).not.toBe('verified');
  });
});
