/**
 * The Go API's endpoint bodies (Go port spec §4) that the base contracts do
 * not already cover. The AnalysisResult, Answer, ExplainRequest and demo
 * schemas live beside their types; this file adds health, readiness,
 * capabilities, the asynchronous analysis (created, status, events),
 * speech, references, the list bodies and the Go API's error codes.
 *
 * scripts/contract/go-contract.test.ts validates the running Go API
 * against these schemas.
 */
import { z } from 'zod';
import { DemoScenarioSummarySchema } from './analysis';
import { ErrorCodeSchema } from './errors';
import { AdvisorySchema, ReferenceRecordSchema } from './match';

export const ModelProviderSchema = z.enum(['mock', 'muse_spark']);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const ReferenceProviderSchema = z.enum(['fixture', 'ph_fda']);
export type ReferenceProvider = z.infer<typeof ReferenceProviderSchema>;

/** GET /healthz: liveness, no dependencies. */
export const HealthzSchema = z.object({ status: z.literal('ok') });
export type Healthz = z.infer<typeof HealthzSchema>;

/**
 * GET /readyz: 200 "ready", or 503 "shutting_down" once shutdown has begun.
 * The model check says only whether a live model is configured.
 */
export const ReadyzSchema = z.object({
  status: z.enum(['ready', 'shutting_down']),
  checks: z.object({
    model: z.enum(['mock', 'configured']),
    references: ReferenceProviderSchema,
  }),
});
export type Readyz = z.infer<typeof ReadyzSchema>;

/** GET /api/v1/config/capabilities. Never carries a secret. */
export const CapabilitiesSchema = z.object({
  modelProvider: ModelProviderSchema,
  /** The live model id; null for the mock. */
  modelId: z.string().min(1).nullable(),
  referenceProvider: ReferenceProviderSchema,
  /** Fixed by Go port spec §4 (final review M16). */
  maxImages: z.literal(3),
  maxImageBytes: z.number().int().positive(),
  /** Fixed by Go port spec §4 (final review M16). */
  ttlSeconds: z.literal(900),
  presets: z.array(z.string().min(1)),
  demoScenarios: z.array(DemoScenarioSummarySchema),
  streaming: z.object({ analysisEvents: z.boolean() }),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** The base error codes plus the Go API's own (Go port spec §4). */
export const ApiErrorCodeSchema = z.enum([
  ...ErrorCodeSchema.options,
  'ANALYSIS_NOT_READY',
  'ANALYSIS_FAILED',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorDetailSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string(),
  requestId: z.string(),
});
export type ApiErrorDetail = z.infer<typeof ApiErrorDetailSchema>;

/** Every Go API error response. Never carries a stack trace. */
export const ApiErrorBodySchema = z.object({ error: ApiErrorDetailSchema });
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

/** 202 answer of POST /api/v1/analyses and POST /api/v1/demo/scenarios. */
export const AnalysisCreatedSchema = z.object({
  id: z.string().min(1),
  status: z.literal('processing'),
});
export type AnalysisCreated = z.infer<typeof AnalysisCreatedSchema>;

/**
 * Progress stages, emitted only when a stage actually runs. completed,
 * needs_attention (a result that needs the user's attention) and failed (an
 * error, no result) end an analysis.
 */
export const AnalysisStageSchema = z.enum([
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
export type AnalysisStage = z.infer<typeof AnalysisStageSchema>;

export const AnalysisStateSchema = z.enum(['processing', 'completed', 'failed']);
export type AnalysisState = z.infer<typeof AnalysisStateSchema>;

/** One progress event; `label` is plain English for speech, `seq` the SSE id. */
export const AnalysisEventSchema = z.object({
  seq: z.number().int().positive(),
  stage: AnalysisStageSchema,
  label: z.string().min(1),
  at: z.iso.datetime(),
});
export type AnalysisEvent = z.infer<typeof AnalysisEventSchema>;

/** SSE event names of GET /api/v1/analyses/{id}/events. */
export const AnalysisEventNameSchema = z.enum(['stage', 'completed', 'failed']);
export type AnalysisEventName = z.infer<typeof AnalysisEventNameSchema>;

/** GET /api/v1/analyses/{id}. `error` is present exactly when the analysis failed. */
export const AnalysisStatusSchema = z
  .object({
    id: z.string().min(1),
    status: AnalysisStateSchema,
    stage: AnalysisStageSchema,
    events: z.array(AnalysisEventSchema),
    error: ApiErrorDetailSchema.optional(),
    isDemo: z.boolean(),
  })
  .refine((s) => (s.status === 'failed') === (s.error !== undefined), {
    message: 'error is present exactly when the status is failed',
    path: ['error'],
  });
export type AnalysisStatus = z.infer<typeof AnalysisStatusSchema>;

/** POST /api/v1/analyses/{id}/speak body. */
export const SpeakRequestSchema = z.discriminatedUnion('target', [
  z.object({ target: z.literal('summary') }),
  z.object({
    target: z.literal('answer'),
    text: z.string().refine((s) => s.trim() !== '', { message: 'text is blank' }),
  }),
]);
export type SpeakRequest = z.infer<typeof SpeakRequestSchema>;

/** POST /api/v1/analyses/{id}/speak answer: text for the device's speech engine. */
export const SpeechSchema = z.object({
  language: z.literal('en-US'),
  chunks: z.array(z.string()),
});
export type Speech = z.infer<typeof SpeechSchema>;

/**
 * GET /api/v1/analyses/{id}/references: the registry side of a result.
 * `checkedAt` is null when no registry data was retrieved, and for demo results.
 */
export const AnalysisReferencesSchema = z.object({
  candidates: z.array(ReferenceRecordSchema),
  advisories: z.array(AdvisorySchema),
  limitations: z.array(z.string()),
  checkedAt: z.iso.datetime().nullable(),
});
export type AnalysisReferences = z.infer<typeof AnalysisReferencesSchema>;

/** GET /api/v1/questions/presets. */
export const PresetQuestionsSchema = z.array(z.string().min(1));

/** GET /api/v1/demo/scenarios. */
export const DemoScenarioListSchema = z.array(DemoScenarioSummarySchema);
