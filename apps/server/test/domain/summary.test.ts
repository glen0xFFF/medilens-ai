import {
  ExplanationSchema,
  type ExtractedLabel,
  type FieldKey,
  type Legibility,
  type MatchAssessment,
  type MatchStatus,
  type PipelineState,
  type QualityReport,
  type ReferenceRecord,
} from '@medilens/contracts';
import { describe, expect, test } from 'vitest';
import { REGISTRY_NOT_CHECKED, buildSummary } from '../../src/domain/summary';

const FINAL = 'Confirm with your pharmacist or doctor.';
const ADVISORY =
  'The FDA has issued an advisory about counterfeit versions of this product. Check with your pharmacist.';
const NO_MATCH =
  'No matching registration found. This does not mean the product is fake. Ask your pharmacist.';
const LOOSE_PILL =
  "This looks like a loose tablet. I can't identify a medicine from how it looks. Please ask a pharmacist.";
const REG_NOT_FOUND = 'The registration number on the pack was not found in the registry.';

type FieldSpec = string | [value: string | null, legibility: Legibility];

function label(
  fields: Partial<Record<FieldKey, FieldSpec>>,
  imageKind: ExtractedLabel['imageKind'] = 'label',
): ExtractedLabel {
  return {
    imageKind,
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

const PACK = label({
  brandName: 'Fevrinol',
  genericNames: 'Paracetamol',
  strength: '500 mg',
  dosageForm: 'Tablet',
  registrationNumber: 'DR-XY12345',
  directions: 'Take 1 tablet every 4 to 6 hours as needed.',
  warnings: 'Do not exceed 8 tablets in 24 hours.',
  expiryDate: '2028-03',
});

const RECORD: ReferenceRecord = {
  provider: 'ph-fda',
  sourceUrl: 'https://verification.fda.gov.ph/drugs/DR-XY12345',
  registrationNumber: 'DR-XY12345',
  brandName: 'Fevrinol',
  genericName: 'Paracetamol',
  strengthForm: '500 mg Tablet',
  manufacturer: 'Demo Pharma Inc.',
  classification: 'OTC',
  registrationExpiry: '2031-12-25',
  checkedAt: '2026-10-27T00:00:00.000Z',
};

function match(status: MatchStatus, overrides: Partial<MatchAssessment> = {}): MatchAssessment {
  return {
    status,
    matched: [],
    conflicting: [],
    missing: [],
    candidates: status === 'unavailable' || status === 'not_attempted' ? [] : [RECORD],
    advisories: [],
    limitations: [],
    ...overrides,
  };
}

const GOOD_QUALITY: QualityReport = {
  ok: true,
  sharpness: 40,
  luminance: 120,
  glareFraction: 0,
  reasons: [],
};

function summary(
  overrides: Partial<{
    label: ExtractedLabel | null;
    quality: QualityReport;
    match: MatchAssessment;
    isDemo: boolean;
    pipelineState: PipelineState;
  }> = {},
) {
  return buildSummary({
    label: PACK,
    quality: GOOD_QUALITY,
    match: match('verified'),
    isDemo: false,
    pipelineState: 'explanation_ready',
    ...overrides,
  });
}

function spoken(e: { spokenChunks: string[] }): string {
  return e.spokenChunks.join(' ');
}

const ALL_STATUSES: MatchStatus[] = [
  'verified',
  'partial',
  'conflicting',
  'ambiguous',
  'no_match',
  'unavailable',
  'not_attempted',
];
const ALL_STATES: PipelineState[] = [
  'label_unreadable',
  'not_a_label',
  'loose_pill',
  'text_extracted',
  'explanation_ready',
];

describe('buildSummary — invariants over every status and state', () => {
  const cases: [MatchStatus, PipelineState, boolean, boolean][] = [];
  for (const s of ALL_STATUSES)
    for (const p of ALL_STATES)
      for (const demo of [false, true])
        for (const adv of [false, true]) cases.push([s, p, demo, adv]);

  test.each(cases)('%s / %s / demo=%s / advisory=%s', (status, pipelineState, isDemo, advisory) => {
    const e = summary({
      match: match(status, {
        advisories: advisory
          ? [{ title: 'Counterfeit Fevrinol alert', url: 'https://www.fda.gov.ph/advisory-1' }]
          : [],
        conflicting:
          status === 'conflicting'
            ? [{ key: 'strength', labelValue: '500 mg', referenceValue: '250 mg' }]
            : [],
      }),
      pipelineState,
      isDemo,
    });
    expect(ExplanationSchema.parse(e)).toEqual(e);
    expect(e.spokenChunks.at(-1)).toBe(FINAL);
    for (const chunk of e.spokenChunks) {
      expect(chunk.length).toBeLessThanOrEqual(400);
      expect(chunk.length).toBeGreaterThan(0);
    }
    // registry certificate expiry is never spoken as anything
    expect(spoken(e)).not.toContain('2031');
    expect(e.displayText).not.toContain('2031');
    // "fake"/"counterfeit" only inside the two fixed sentences
    const scrubbed = spoken(e).replaceAll(ADVISORY, '').replaceAll(NO_MATCH, '');
    expect(scrubbed).not.toMatch(/fake|counterfeit/i);
    expect(e.displayText.replaceAll(ADVISORY, '').replaceAll(NO_MATCH, '')).not.toMatch(
      /fake|counterfeit/i,
    );
    if (isDemo) expect(e.spokenChunks[0]?.startsWith('Demo data.')).toBe(true);
    else expect(spoken(e)).not.toContain('Demo data.');
  });
});

describe('buildSummary — template content', () => {
  test('demo first chunk starts "Demo data." and last chunk is the final line', () => {
    const e = summary({ isDemo: true });
    expect(e.spokenChunks[0]?.startsWith('Demo data.')).toBe(true);
    expect(e.spokenChunks.at(-1)).toBe(FINAL);
  });

  test('spoken order follows spec §5.5', () => {
    const text = spoken(
      summary({
        isDemo: true,
        match: match('verified', {
          advisories: [{ title: 'Counterfeit alert', url: 'https://www.fda.gov.ph/a' }],
        }),
        label: label({
          brandName: 'Fevrinol',
          strength: '500 mg',
          dosageForm: 'Tablet',
          directions: 'Take 1 tablet every 4 to 6 hours.',
          warnings: 'Do not exceed 8 tablets in 24 hours.',
          expiryDate: '2028-03',
          batchNumber: ['B12?', 'partial'],
        }),
      }),
    );
    const order = [
      'Demo data.',
      'Fevrinol',
      'This matches a product in the Philippine FDA registry.',
      ADVISORY,
      'Take 1 tablet every 4 to 6 hours.',
      'Do not exceed 8 tablets in 24 hours.',
      '2028-03',
      'unclear',
      FINAL,
    ];
    const positions = order.map((s) => text.indexOf(s));
    for (const p of positions) expect(p).toBeGreaterThanOrEqual(0);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test('product name, strength and form are spoken', () => {
    const text = spoken(summary());
    expect(text).toContain('Fevrinol');
    expect(text).toContain('Paracetamol');
    expect(text).toContain('500 mg');
    expect(text).toContain('Tablet');
  });

  test('non-clear field values are spoken with the unclear marker', () => {
    const e = summary({ label: label({ brandName: 'Fevrinol', strength: ['500 mg', 'partial'] }) });
    expect(spoken(e)).toContain('500 mg, but this part is unclear');
  });

  test('unclear-fields sentence names fields that were not clear, including unreadable ones', () => {
    const e = summary({
      label: label({
        brandName: 'Fevrinol',
        strength: ['500 mg', 'partial'],
        expiryDate: [null, 'unreadable'],
      }),
    });
    const text = spoken(e);
    expect(text).toMatch(/Some parts were unclear: strength, expiry date\./);
  });

  test('verified sentence', () => {
    expect(spoken(summary())).toContain('This matches a product in the Philippine FDA registry.');
  });

  test('partial sentence', () => {
    expect(spoken(summary({ match: match('partial') }))).toContain(
      'This partly matches a product in the Philippine FDA registry. Some details could not be confirmed.',
    );
  });

  test('conflicting strength names the field and does not claim a match', () => {
    const text = spoken(
      summary({
        match: match('conflicting', {
          conflicting: [
            { key: 'strength', labelValue: '500 mg', referenceValue: '250 mg' },
            { key: 'strength', labelValue: '500 mg', referenceValue: '125 mg' },
            { key: 'brandName', labelValue: 'Fevrinol', referenceValue: 'Fevrinox' },
          ],
        }),
      }),
    );
    expect(text).toContain('The strength on the label does not match the registry.');
    expect(text).toContain('The brand name on the label does not match the registry.');
    expect(text.match(/The strength on the label/g)).toHaveLength(1);
    expect(text).not.toContain('matches a product');
  });

  test('ambiguous sentence', () => {
    expect(spoken(summary({ match: match('ambiguous') }))).toContain(
      "More than one registered product could match this label. I can't tell which one.",
    );
  });

  test('no_match sentence', () => {
    const text = spoken(summary({ match: match('no_match', { candidates: [] }) }));
    expect(text).toContain(NO_MATCH);
    expect(text).toContain('does not mean the product is fake');
  });

  test('unavailable sentence', () => {
    expect(spoken(summary({ match: match('unavailable') }))).toContain(
      "I couldn't check the FDA registry right now.",
    );
  });

  // final review Minor 1: a speech-only user hears that the registry was not checked
  test('not_attempted says only that the registry was not checked', () => {
    const text = spoken(summary({ match: match('not_attempted') }));
    expect(text).toContain(REGISTRY_NOT_CHECKED);
    expect(text.replace(REGISTRY_NOT_CHECKED, '')).not.toMatch(/registry/i);
  });

  test('advisory sentence plays for any status, including verified', () => {
    for (const status of ALL_STATUSES) {
      const e = summary({
        match: match(status, {
          advisories: [{ title: 'Counterfeit x', url: 'https://www.fda.gov.ph/x' }],
        }),
      });
      expect(spoken(e)).toContain(ADVISORY);
      expect(e.safetyNotices).toContain(ADVISORY);
    }
  });

  test('advisory title text from the registry is not spoken', () => {
    const e = summary({
      match: match('verified', {
        advisories: [{ title: 'Counterfeit Fevrinol fake', url: 'https://www.fda.gov.ph/x' }],
      }),
    });
    expect(spoken(e)).not.toContain('Counterfeit Fevrinol fake');
  });

  test('registration-not-found limitation is spoken; other limitations are not', () => {
    const text = spoken(
      summary({
        match: match('partial', {
          limitations: ["Registration expiry is not the product's expiry date.", REG_NOT_FOUND],
        }),
      }),
    );
    expect(text).toContain(REG_NOT_FOUND);
    expect(text).not.toContain('Registration expiry');
  });

  test('advisories-unchecked limitation is spoken', () => {
    const note = 'FDA safety advisories for this product could not be checked.';
    const text = spoken(summary({ match: match('verified', { limitations: [note] }) }));
    expect(text).toContain(note);
  });

  test('pack expiry is spoken as printed on the pack', () => {
    expect(spoken(summary())).toMatch(/Expiry date printed on the pack: 2028-03\./);
  });

  test('supportingFields lists the fields spoken from the label', () => {
    const e = summary();
    expect(e.supportingFields).toEqual(
      expect.arrayContaining(['brandName', 'strength', 'directions', 'warnings', 'expiryDate']),
    );
    expect(e.supportingFields).not.toContain('batchNumber');
  });

  test('long printed text is split into chunks of at most 400 characters at sentence boundaries', () => {
    const sentence =
      'Keep this medicine out of the reach of children and store below thirty degrees.';
    const warnings = Array.from({ length: 15 }, () => sentence).join(' ');
    const e = summary({ label: label({ brandName: 'Fevrinol', warnings }) });
    for (const c of e.spokenChunks) expect(c.length).toBeLessThanOrEqual(400);
    expect(e.spokenChunks.filter((c) => c.includes('Keep this medicine')).length).toBeGreaterThan(
      1,
    );
    for (const c of e.spokenChunks.filter((c) => c.includes('Keep this medicine')))
      expect(c.endsWith('.')).toBe(true);
  });

  test('a single sentence longer than 400 characters is split at word boundaries', () => {
    const warnings = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    const e = summary({ label: label({ brandName: 'Fevrinol', warnings }) });
    for (const c of e.spokenChunks) expect(c.length).toBeLessThanOrEqual(400);
    expect(spoken(e)).toContain('word119');
  });

  test('a decimal dose in long printed text is never split at its decimal point', () => {
    const filler = Array.from(
      { length: 10 },
      () => 'Keep this medicine out of the reach of children and store below thirty degrees.',
    ).join(' ');
    const directions = `${filler} Adults: take 2.5 mL every 6 hours. ${filler}`;
    const e = summary({ label: label({ brandName: 'Fevrinol', directions }) });
    for (const c of e.spokenChunks) expect(c.length).toBeLessThanOrEqual(400);
    expect(e.spokenChunks.some((c) => c.includes('Adults: take 2.5 mL every 6 hours.'))).toBe(
      true,
    );
    expect(spoken(e)).not.toContain('2. 5');
  });

  test('every chunk of a long partly unclear value carries the unclear marker', () => {
    const directions = Array.from(
      { length: 12 },
      (_, i) => `Step ${i + 1}: shake well and take 2.5 mL using the cup provided.`,
    ).join(' ');
    const e = summary({ label: label({ brandName: 'Fevrinol', directions: [directions, 'partial'] }) });
    const carrying = e.spokenChunks.filter((c) => /Step \d+/.test(c));
    expect(carrying.length).toBeGreaterThan(1);
    for (const c of carrying) {
      expect(c.length).toBeLessThanOrEqual(400);
      expect(c).toMatch(/unclear/);
    }
    // the marker comes before the value, not after it
    const first = carrying[0] ?? '';
    expect(first.indexOf('unclear')).toBeLessThan(first.indexOf('Step 1'));
  });

  test('a short partly unclear directions value is introduced by the marker', () => {
    const e = summary({
      label: label({ brandName: 'Fevrinol', directions: ['Take 2.5 mL twice daily', 'partial'] }),
    });
    expect(spoken(e)).toContain('Directions as printed, partly unclear: Take 2.5 mL twice daily.');
  });

  test('displayText carries every spoken chunk', () => {
    const e = summary({ isDemo: true });
    for (const c of e.spokenChunks) expect(e.displayText).toContain(c);
  });
});

describe('buildSummary — non-label states', () => {
  test('loose_pill speaks the exact sentence then the final line, and no field values', () => {
    const e = summary({
      pipelineState: 'loose_pill',
      label: label({ brandName: 'Fevrinol', strength: '500 mg' }, 'loose_pill'),
    });
    expect(e.spokenChunks).toEqual([LOOSE_PILL, FINAL]);
    expect(e.displayText).not.toContain('Fevrinol');
    expect(e.supportingFields).toEqual([]);
  });

  test('loose_pill in demo is prefixed by the demo notice', () => {
    const e = summary({ pipelineState: 'loose_pill', isDemo: true });
    expect(e.spokenChunks[0]?.startsWith('Demo data.')).toBe(true);
    expect(spoken(e)).toContain(LOOSE_PILL);
    expect(spoken(e)).not.toContain('Fevrinol');
  });

  test('not_a_label', () => {
    const e = summary({ pipelineState: 'not_a_label', label: label({}, 'not_medicine') });
    expect(e.spokenChunks).toEqual(["I couldn't find a medicine label in this photo.", FINAL]);
  });

  test('label_unreadable with null label explains each quality reason', () => {
    const e = summary({
      pipelineState: 'label_unreadable',
      label: null,
      match: match('not_attempted'),
      quality: { ...GOOD_QUALITY, ok: false, reasons: ['BLURRY', 'TOO_DARK', 'GLARE'] },
    });
    const text = spoken(e);
    expect(text).toContain(
      'The photo is blurry. The photo is too dark. There is glare on the label. Please take another photo.',
    );
    expect(e.spokenChunks.at(-1)).toBe(FINAL);
    expect(e.supportingFields).toEqual([]);
  });

  test('label_unreadable with no quality reason still asks for another photo', () => {
    const e = summary({ pipelineState: 'label_unreadable', label: label({}, 'unreadable') });
    expect(spoken(e)).toContain('Please take another photo.');
    expect(spoken(e)).not.toContain('blurry');
  });

  test('a null label in a normal state never invents field values', () => {
    const e = summary({
      pipelineState: 'explanation_ready',
      label: null,
      match: match('not_attempted'),
    });
    expect(spoken(e)).toContain('Please take another photo.');
    expect(e.spokenChunks.at(-1)).toBe(FINAL);
  });
});

describe('buildSummary — final review fixes', () => {
  const NOT_CHECKED = 'The FDA registry was not checked.';
  const NEUTRAL =
    'The FDA has issued an advisory that mentions this product. Check with your pharmacist.';

  test('Minor 1: a label read with no registry search says the registry was not checked', () => {
    const e = summary({
      match: match('not_attempted', {
        limitations: ['Not enough clear text to search the registry.'],
      }),
    });
    expect(e.spokenChunks).toContain(NOT_CHECKED);
    expect(REGISTRY_NOT_CHECKED).toBe(NOT_CHECKED);
  });

  test('Minor 1: the not-checked sentence comes where the status sentence would', () => {
    const e = summary({ match: match('not_attempted') });
    const at = e.spokenChunks.indexOf(NOT_CHECKED);
    expect(at).toBe(1);
    expect(e.spokenChunks[0]?.startsWith('This label reads:')).toBe(true);
  });

  test('Minor 8: an advisory title without "counterfeit" gets the neutral sentence', () => {
    const e = summary({
      match: match('verified', {
        advisories: [{ title: 'Recall of Fevrinol 500 mg', url: 'https://www.fda.gov.ph/x' }],
      }),
    });
    expect(spoken(e)).toContain(NEUTRAL);
    expect(e.safetyNotices).toContain(NEUTRAL);
    expect(spoken(e)).not.toMatch(/counterfeit|fake/i);
  });

  test('Minor 8: a title saying "counterfeit" in any case gets the fixed counterfeit sentence', () => {
    const e = summary({
      match: match('verified', {
        advisories: [{ title: 'COUNTERFEIT Fevrinol warning', url: 'https://www.fda.gov.ph/x' }],
      }),
    });
    expect(spoken(e)).toContain(ADVISORY);
    expect(spoken(e)).not.toContain(NEUTRAL);
  });
});
