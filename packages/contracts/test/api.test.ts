/**
 * Schemas of the Go API's endpoints (Go port spec §4). The cross-language
 * test (scripts/contract/go-contract.test.ts) validates the running Go API
 * against them; these tests pin the schemas themselves.
 */
import { describe, expect, test } from 'vitest';
import {
  AnalysisCreatedSchema,
  AnalysisEventNameSchema,
  AnalysisEventSchema,
  AnalysisReferencesSchema,
  AnalysisResultSchema,
  AnalysisStageSchema,
  AnalysisStateSchema,
  AnalysisStatusSchema,
  ApiErrorBodySchema,
  ApiErrorCodeSchema,
  CapabilitiesSchema,
  DemoScenarioListSchema,
  ErrorCodeSchema,
  HealthzSchema,
  ModelProviderSchema,
  PresetQuestionsSchema,
  ProvenanceSchema,
  ReadyzSchema,
  ReferenceProviderSchema,
  SpeakRequestSchema,
  SpeechSchema,
} from '../src/index';

const event = {
  seq: 1,
  stage: 'received',
  label: 'Request received.',
  at: '2026-10-28T10:00:00.000Z',
};

describe('health', () => {
  test('healthz is exactly {status: "ok"}', () => {
    expect(HealthzSchema.safeParse({ status: 'ok' }).success).toBe(true);
    expect(HealthzSchema.safeParse({ status: 'up' }).success).toBe(false);
  });

  test('readyz names the providers, and is shutting_down during shutdown', () => {
    const checks = { model: 'mock', references: 'fixture' };
    expect(ReadyzSchema.safeParse({ status: 'ready', checks }).success).toBe(true);
    expect(ReadyzSchema.safeParse({ status: 'shutting_down', checks }).success).toBe(true);
    expect(
      ReadyzSchema.safeParse({
        status: 'ready',
        checks: { model: 'configured', references: 'ph_fda' },
      }).success,
    ).toBe(true);
    // the model check never names a key or a model id
    expect(
      ReadyzSchema.safeParse({
        status: 'ready',
        checks: { model: 'muse-spark-1.3', references: 'fixture' },
      }).success,
    ).toBe(false);
    expect(ReadyzSchema.safeParse({ status: 'ready' }).success).toBe(false);
  });
});

describe('providers', () => {
  test('model and reference providers are the spec values', () => {
    expect(ModelProviderSchema.options).toEqual(['mock', 'muse_spark']);
    expect(ReferenceProviderSchema.options).toEqual(['fixture', 'ph_fda']);
  });
});

describe('capabilities', () => {
  const capabilities = {
    modelProvider: 'mock',
    modelId: null,
    referenceProvider: 'fixture',
    maxImages: 3,
    maxImageBytes: 8 * 1024 * 1024,
    ttlSeconds: 900,
    presets: ['What strength is printed here?'],
    demoScenarios: [
      { id: 's1-clear', title: 'Clear label' },
      { id: 's7-unsupported-question', title: 'Dose', presetQuestion: 'How many should I take?' },
    ],
    streaming: { analysisEvents: true },
  };

  test('parses the mock capabilities, and a live model id', () => {
    expect(CapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(
      CapabilitiesSchema.safeParse({
        ...capabilities,
        modelProvider: 'muse_spark',
        modelId: 'muse-spark-1.3',
        referenceProvider: 'ph_fda',
      }).success,
    ).toBe(true);
  });

  test('modelId must be present (null for the mock), never omitted', () => {
    const { modelId: _omitted, ...withoutModelId } = capabilities;
    expect(CapabilitiesSchema.safeParse(withoutModelId).success).toBe(false);
    expect(CapabilitiesSchema.safeParse({ ...capabilities, modelId: '' }).success).toBe(false);
  });

  test('rejects an unknown provider and a non-integer limit', () => {
    expect(CapabilitiesSchema.safeParse({ ...capabilities, modelProvider: 'claude' }).success).toBe(
      false,
    );
    expect(CapabilitiesSchema.safeParse({ ...capabilities, maxImages: 2.5 }).success).toBe(false);
    expect(CapabilitiesSchema.safeParse({ ...capabilities, streaming: {} }).success).toBe(false);
  });
});

describe('analyses', () => {
  test('a create answers 202 {id, status: "processing"}', () => {
    expect(AnalysisCreatedSchema.safeParse({ id: 'a1', status: 'processing' }).success).toBe(true);
    expect(AnalysisCreatedSchema.safeParse({ id: 'a1', status: 'completed' }).success).toBe(false);
    expect(AnalysisCreatedSchema.safeParse({ id: '', status: 'processing' }).success).toBe(false);
  });

  test('stages, states and SSE event names are the spec values', () => {
    expect(AnalysisStageSchema.options).toEqual([
      'received',
      'quality',
      'reading',
      'reviewing_fields',
      'checking_references',
      'comparing',
      'explaining',
      'completed',
      'needs_attention',
      'failed',
    ]);
    expect(AnalysisStateSchema.options).toEqual(['processing', 'completed', 'failed']);
    expect(AnalysisEventNameSchema.options).toEqual(['stage', 'completed', 'failed']);
  });

  test('an event is {seq, stage, label, at}', () => {
    expect(AnalysisEventSchema.safeParse(event).success).toBe(true);
    expect(AnalysisEventSchema.safeParse({ ...event, seq: 0 }).success).toBe(false);
    expect(AnalysisEventSchema.safeParse({ ...event, label: '' }).success).toBe(false);
    expect(AnalysisEventSchema.safeParse({ ...event, at: 'now' }).success).toBe(false);
    expect(AnalysisEventSchema.safeParse({ ...event, stage: 'ocr' }).success).toBe(false);
  });

  const processing = {
    id: 'a1',
    status: 'processing',
    stage: 'received',
    events: [event],
    isDemo: false,
  };
  const failure = { code: 'INVALID_IMAGE', message: 'Please send a JPEG.', requestId: 'r1' };

  test('a status carries an error exactly when it is failed', () => {
    expect(AnalysisStatusSchema.safeParse(processing).success).toBe(true);
    expect(
      AnalysisStatusSchema.safeParse({
        ...processing,
        status: 'failed',
        stage: 'failed',
        error: failure,
      }).success,
    ).toBe(true);
    expect(
      AnalysisStatusSchema.safeParse({ ...processing, status: 'failed', stage: 'failed' }).success,
    ).toBe(false);
    expect(AnalysisStatusSchema.safeParse({ ...processing, error: failure }).success).toBe(false);
    expect(AnalysisStatusSchema.safeParse({ ...processing, error: null }).success).toBe(false);
  });

  test('a status error may carry the Go API codes', () => {
    expect(
      AnalysisStatusSchema.safeParse({
        ...processing,
        status: 'failed',
        stage: 'failed',
        error: { ...failure, code: 'ANALYSIS_FAILED' },
      }).success,
    ).toBe(true);
  });

  test('the events list is required, possibly empty, never null', () => {
    expect(AnalysisStatusSchema.safeParse({ ...processing, events: [] }).success).toBe(true);
    expect(AnalysisStatusSchema.safeParse({ ...processing, events: null }).success).toBe(false);
  });
});

describe('result provenance', () => {
  test('provenance names the model and the reference provider', () => {
    expect(ProvenanceSchema.safeParse({ model: 'mock', references: 'fixture' }).success).toBe(true);
    expect(
      ProvenanceSchema.safeParse({ model: 'muse-spark-1.3', references: 'ph_fda' }).success,
    ).toBe(true);
    expect(ProvenanceSchema.safeParse({ model: '', references: 'fixture' }).success).toBe(false);
    expect(ProvenanceSchema.safeParse({ model: 'mock', references: 'web' }).success).toBe(false);
  });

  test('AnalysisResult keeps an optional provenance and does not strip it', () => {
    const shape = AnalysisResultSchema.shape;
    expect(shape.provenance.safeParse(undefined).success).toBe(true);
    expect(shape.provenance.safeParse({ model: 'mock', references: 'fixture' }).success).toBe(true);
    expect(shape.provenance.safeParse(null).success).toBe(false);
  });
});

describe('explanation and speech', () => {
  test('a speak request is the summary, or an answer with text', () => {
    expect(SpeakRequestSchema.safeParse({ target: 'summary' }).success).toBe(true);
    expect(
      SpeakRequestSchema.safeParse({ target: 'answer', text: 'It reads 500 mg.' }).success,
    ).toBe(true);
    expect(SpeakRequestSchema.safeParse({ target: 'answer' }).success).toBe(false);
    expect(SpeakRequestSchema.safeParse({ target: 'answer', text: ' \n ' }).success).toBe(false);
    expect(SpeakRequestSchema.safeParse({ target: 'label' }).success).toBe(false);
  });

  test('speech is {language: "en-US", chunks}', () => {
    expect(SpeechSchema.safeParse({ language: 'en-US', chunks: ['One.', 'Two.'] }).success).toBe(
      true,
    );
    expect(SpeechSchema.safeParse({ language: 'fil-PH', chunks: [] }).success).toBe(false);
    expect(SpeechSchema.safeParse({ language: 'en-US' }).success).toBe(false);
  });
});

describe('references and lists', () => {
  test('references: candidates, advisories, limitations and a nullable checkedAt', () => {
    const refs = { candidates: [], advisories: [], limitations: [], checkedAt: null };
    expect(AnalysisReferencesSchema.safeParse(refs).success).toBe(true);
    expect(
      AnalysisReferencesSchema.safeParse({ ...refs, checkedAt: '2026-10-28T10:00:00.000Z' })
        .success,
    ).toBe(true);
    const { checkedAt: _omitted, ...withoutCheckedAt } = refs;
    expect(AnalysisReferencesSchema.safeParse(withoutCheckedAt).success).toBe(false);
    expect(
      AnalysisReferencesSchema.safeParse({
        ...refs,
        advisories: [{ title: 'Advisory', url: 'javascript:alert(1)' }],
      }).success,
    ).toBe(false);
  });

  test('presets and demo scenarios are lists', () => {
    expect(PresetQuestionsSchema.safeParse(['What strength is printed here?']).success).toBe(true);
    expect(PresetQuestionsSchema.safeParse(['']).success).toBe(false);
    expect(DemoScenarioListSchema.safeParse([{ id: 's1-clear', title: 'Clear' }]).success).toBe(
      true,
    );
    expect(DemoScenarioListSchema.safeParse(null).success).toBe(false);
  });
});

describe('api errors', () => {
  test('the Go API codes are the base codes plus ANALYSIS_NOT_READY and ANALYSIS_FAILED', () => {
    expect(ApiErrorCodeSchema.options).toEqual([
      ...ErrorCodeSchema.options,
      'ANALYSIS_NOT_READY',
      'ANALYSIS_FAILED',
    ]);
  });

  test('an api error body is {error: {code, message, requestId}}', () => {
    const body = {
      error: {
        code: 'ANALYSIS_NOT_READY',
        message: 'The analysis is still running.',
        requestId: 'r1',
      },
    };
    expect(ApiErrorBodySchema.safeParse(body).success).toBe(true);
    expect(
      ApiErrorBodySchema.safeParse({ error: { ...body.error, code: 'NETWORK' } }).success,
    ).toBe(false);
    expect(
      ApiErrorBodySchema.safeParse({ error: { code: 'NOT_FOUND', message: 'x' } }).success,
    ).toBe(false);
  });
});
