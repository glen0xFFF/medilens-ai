import { z } from 'zod';
import { ExtractedLabelSchema, FieldKeySchema } from './label';
import { MatchAssessmentSchema } from './match';

export const QualityReasonSchema = z.enum(['BLURRY', 'TOO_DARK', 'GLARE']);
export type QualityReason = z.infer<typeof QualityReasonSchema>;

export const QualityReportSchema = z.object({
  ok: z.boolean(),
  sharpness: z.number().nonnegative(),
  luminance: z.number().min(0).max(255),
  glareFraction: z.number().min(0).max(1),
  reasons: z.array(QualityReasonSchema),
});
export type QualityReport = z.infer<typeof QualityReportSchema>;

export const ExplanationSchema = z.object({
  displayText: z.string(),
  spokenChunks: z.array(z.string()),
  safetyNotices: z.array(z.string()),
  supportingFields: z.array(FieldKeySchema),
});
export type Explanation = z.infer<typeof ExplanationSchema>;

export const PipelineStateSchema = z.enum([
  'label_unreadable',
  'not_a_label',
  'loose_pill',
  'text_extracted',
  'explanation_ready',
]);
export type PipelineState = z.infer<typeof PipelineStateSchema>;

/**
 * The providers an uploaded scan was analysed with (Go port spec §3, §4):
 * the model id ("mock" for the mock provider) and the reference provider.
 */
export const ProvenanceSchema = z.object({
  model: z.string().min(1),
  references: z.enum(['fixture', 'ph_fda']),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const AnalysisResultSchema = z.object({
  id: z.string().min(1),
  isDemo: z.boolean(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  pipelineState: PipelineStateSchema,
  quality: QualityReportSchema,
  /** null when the image failed the quality check and the reader was never called. */
  label: ExtractedLabelSchema.nullable(),
  match: MatchAssessmentSchema,
  explanation: ExplanationSchema,
  imageRetention: z.literal('none'),
  /** Go API only, on uploaded scans; absent on demo results and from the Node server. */
  provenance: ProvenanceSchema.optional(),
});
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

export const DemoScenarioRequestSchema = z.object({
  scenarioId: z.string().min(1),
});
export type DemoScenarioRequest = z.infer<typeof DemoScenarioRequestSchema>;

export const DemoScenarioSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  /** The question this scenario is built to show (s7), offered as a button on its result. */
  presetQuestion: z.string().min(1).optional(),
});
export type DemoScenarioSummary = z.infer<typeof DemoScenarioSummarySchema>;
