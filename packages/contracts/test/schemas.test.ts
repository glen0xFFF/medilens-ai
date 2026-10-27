import { describe, expect, test } from 'vitest';
import {
  AdvisorySchema,
  AnalysisResultSchema,
  AnswerSchema,
  DemoScenarioRequestSchema,
  DemoScenarioSummarySchema,
  ErrorBodySchema,
  ErrorCodeSchema,
  ExplainRequestSchema,
  ExtractedLabelSchema,
  FieldKeySchema,
  ImageKindSchema,
  LabelFieldSchema,
  MatchAssessmentSchema,
  MatchStatusSchema,
  PipelineStateSchema,
  QualityReportSchema,
  ReferenceRecordSchema,
  type AnalysisResult,
  type MatchAssessment,
} from '../src/index';

const reference = {
  provider: 'fixture',
  sourceUrl: 'https://verification.fda.gov.ph/',
  registrationNumber: 'DR-XY900001',
  brandName: 'Paracelin 500',
  genericName: 'Paracetamol',
  strengthForm: '500 mg Tablet',
  manufacturer: 'DEMO DATA Labs',
  classification: 'Household Remedy',
  registrationExpiry: '2029-01-31',
  checkedAt: '2026-10-27T10:00:00.000Z',
};

const match: MatchAssessment = {
  status: 'verified',
  matched: ['registrationNumber', 'brandName', 'strength'],
  conflicting: [],
  missing: ['dosageForm'],
  candidates: [reference],
  advisories: [],
  limitations: ["Registration expiry is not the product's expiry date."],
};

const result: AnalysisResult = {
  id: 'a1',
  isDemo: true,
  createdAt: '2026-10-27T10:00:00.000Z',
  expiresAt: '2026-10-27T10:15:00.000Z',
  pipelineState: 'explanation_ready',
  quality: { ok: true, sharpness: 30, luminance: 120, glareFraction: 0.01, reasons: [] },
  label: {
    imageKind: 'label',
    fields: [
      {
        key: 'brandName',
        value: 'Paracelin 500',
        legibility: 'clear',
        evidenceText: 'PARACELIN 500',
        imageIndex: 0,
        notes: 'DEMO DATA',
      },
    ],
    rawText: 'PARACELIN 500',
    warnings: [],
  },
  match,
  explanation: {
    displayText: 'Demo data. Paracelin 500.',
    spokenChunks: ['Demo data. Paracelin 500.', 'Confirm with your pharmacist or doctor.'],
    safetyNotices: [],
    supportingFields: ['brandName'],
  },
  imageRetention: 'none',
};

describe('label', () => {
  test('LabelField allows null value but not missing key', () => {
    expect(
      LabelFieldSchema.safeParse({
        key: 'strength',
        value: null,
        legibility: 'unreadable',
        evidenceText: null,
        imageIndex: null,
        notes: null,
      }).success,
    ).toBe(true);
    expect(LabelFieldSchema.safeParse({ value: '500 mg', legibility: 'clear' }).success).toBe(
      false,
    );
  });

  test('LabelField requires nullable fields to be present, not omitted', () => {
    expect(
      LabelFieldSchema.safeParse({ key: 'strength', value: '500 mg', legibility: 'clear' }).success,
    ).toBe(false);
  });

  test('FieldKey has exactly the 12 spec keys', () => {
    expect(FieldKeySchema.options).toEqual([
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
    ]);
  });

  test('ImageKind has exactly the 4 plan values', () => {
    expect(ImageKindSchema.options).toEqual(['label', 'loose_pill', 'not_medicine', 'unreadable']);
  });

  test('ExtractedLabel rejects an unknown field key', () => {
    const bad = {
      imageKind: 'label',
      fields: [
        {
          key: 'colour',
          value: 'white',
          legibility: 'clear',
          evidenceText: null,
          imageIndex: null,
          notes: null,
        },
      ],
      rawText: '',
      warnings: [],
    };
    expect(ExtractedLabelSchema.safeParse(bad).success).toBe(false);
  });

  test('QualityReport only accepts the 3 spec reasons', () => {
    const base = { ok: false, sharpness: 3, luminance: 20, glareFraction: 0 };
    expect(
      QualityReportSchema.safeParse({ ...base, reasons: ['BLURRY', 'TOO_DARK', 'GLARE'] }).success,
    ).toBe(true);
    expect(QualityReportSchema.safeParse({ ...base, reasons: ['TILTED'] }).success).toBe(false);
  });
});

describe('match', () => {
  test('MatchStatus has exactly the 7 spec values', () => {
    expect(MatchStatusSchema.options).toEqual([
      'verified',
      'partial',
      'conflicting',
      'ambiguous',
      'no_match',
      'unavailable',
      'not_attempted',
    ]);
  });

  test('ReferenceRecord parses a full record', () => {
    expect(ReferenceRecordSchema.safeParse(reference).success).toBe(true);
  });

  test('MatchAssessment requires advisories and carries conflicts with both values', () => {
    const { advisories: _omitted, ...withoutAdvisories } = match;
    expect(MatchAssessmentSchema.safeParse(withoutAdvisories).success).toBe(false);

    const conflicting = {
      ...match,
      status: 'conflicting',
      conflicting: [{ key: 'strength', labelValue: '500 mg', referenceValue: '250 mg' }],
      advisories: [{ title: 'Counterfeit advisory', url: 'https://www.fda.gov.ph/advisory' }],
    };
    expect(MatchAssessmentSchema.safeParse(conflicting).success).toBe(true);
  });

  const dangerousUrls = ['javascript:alert(1)', 'intent://x#Intent;end', 'file:///etc/passwd'];

  test.each(dangerousUrls)('ReferenceRecord.sourceUrl rejects %s', (url) => {
    expect(ReferenceRecordSchema.safeParse({ ...reference, sourceUrl: url }).success).toBe(false);
  });

  test.each(dangerousUrls)('Advisory.url rejects %s', (url) => {
    expect(AdvisorySchema.safeParse({ title: 'Advisory', url }).success).toBe(false);
  });

  test('ReferenceRecord.sourceUrl and Advisory.url accept https', () => {
    const url = 'https://www.fda.gov.ph/advisory';
    expect(ReferenceRecordSchema.safeParse({ ...reference, sourceUrl: url }).success).toBe(true);
    expect(AdvisorySchema.safeParse({ title: 'Advisory', url }).success).toBe(true);
  });
});

describe('analysis', () => {
  test('AnalysisResult imageRetention is literal none', () => {
    expect(AnalysisResultSchema.safeParse(result).success).toBe(true);
    expect(AnalysisResultSchema.safeParse({ ...result, imageRetention: 'temp' }).success).toBe(
      false,
    );
  });

  test('AnalysisResult allows a null label when the reader was never called', () => {
    const unreadable = {
      ...result,
      pipelineState: 'label_unreadable',
      quality: { ok: false, sharpness: 2, luminance: 120, glareFraction: 0, reasons: ['BLURRY'] },
      label: null,
      match: { ...match, status: 'not_attempted', matched: [], missing: [], candidates: [] },
    };
    expect(AnalysisResultSchema.safeParse(unreadable).success).toBe(true);
  });

  test('AnalysisResult requires ISO timestamps', () => {
    expect(AnalysisResultSchema.safeParse({ ...result, createdAt: 'yesterday' }).success).toBe(
      false,
    );
  });

  test('PipelineState has exactly the 5 spec values', () => {
    expect(PipelineStateSchema.options).toEqual([
      'label_unreadable',
      'not_a_label',
      'loose_pill',
      'text_extracted',
      'explanation_ready',
    ]);
  });

  test('DemoScenario request and summary shapes', () => {
    expect(DemoScenarioRequestSchema.safeParse({ scenarioId: 's1-clear' }).success).toBe(true);
    expect(DemoScenarioRequestSchema.safeParse({ scenarioId: '' }).success).toBe(false);
    expect(
      DemoScenarioSummarySchema.safeParse({ id: 's1-clear', title: 'Clear label' }).success,
    ).toBe(true);
  });

  // Final review Minor 20: a scenario can name the question it is built to show.
  test('DemoScenarioSummary takes an optional, non-empty presetQuestion', () => {
    const s7 = {
      id: 's7-unsupported-question',
      title: 'Unsupported dosing question',
      presetQuestion: 'How many should I take for my headache?',
    };
    expect(DemoScenarioSummarySchema.strict().parse(s7)).toEqual(s7);
    expect(DemoScenarioSummarySchema.safeParse({ ...s7, presetQuestion: '' }).success).toBe(false);
    expect(DemoScenarioSummarySchema.safeParse({ ...s7, presetQuestion: null }).success).toBe(
      false,
    );
  });
});

describe('answer', () => {
  test('ExplainRequest rejects >300 chars and empty', () => {
    expect(ExplainRequestSchema.safeParse({ question: 'x'.repeat(301) }).success).toBe(false);
    expect(ExplainRequestSchema.safeParse({ question: '   ' }).success).toBe(false);
  });

  test('ExplainRequest trims the question and accepts exactly 300 chars', () => {
    expect(ExplainRequestSchema.parse({ question: '  What strength?  ' })).toEqual({
      question: 'What strength?',
    });
    expect(ExplainRequestSchema.safeParse({ question: 'x'.repeat(300) }).success).toBe(true);
  });

  test('Answer status is answered | refused | unclear', () => {
    const answer = {
      status: 'refused',
      text: 'Please ask a pharmacist or your doctor.',
      spokenChunks: ['Please ask a pharmacist or your doctor.'],
      citedFields: [],
      safetyNotice: null,
    };
    expect(AnswerSchema.safeParse(answer).success).toBe(true);
    expect(AnswerSchema.safeParse({ ...answer, status: 'maybe' }).success).toBe(false);
  });
});

describe('errors', () => {
  test('ErrorCode has exactly the 13 spec codes', () => {
    expect(ErrorCodeSchema.options).toEqual([
      'INVALID_IMAGE',
      'IMAGE_TOO_LARGE',
      'LIVE_BUDGET_EXHAUSTED',
      'LABEL_UNREADABLE',
      'OCR_FAILED',
      'REFERENCE_UNAVAILABLE',
      'NO_RELIABLE_MATCH',
      'CONFLICTING_MATCH',
      'UNSUPPORTED_REQUEST',
      'RATE_LIMITED',
      'NOT_FOUND',
      'VALIDATION_FAILED',
      'INTERNAL_ERROR',
    ]);
  });

  test('ErrorBody is {error: {code, message, requestId}}', () => {
    expect(
      ErrorBodySchema.safeParse({
        error: { code: 'NOT_FOUND', message: 'Result expired.', requestId: 'req-1' },
      }).success,
    ).toBe(true);
    expect(
      ErrorBodySchema.safeParse({ error: { code: 'NETWORK', message: 'x', requestId: 'req-1' } })
        .success,
    ).toBe(false);
  });
});
