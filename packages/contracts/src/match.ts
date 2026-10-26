import { z } from 'zod';
import { FieldKeySchema } from './label';

/**
 * One registry row. Only `registrationNumber` identifies the row; the other
 * registry columns are nullable because a source row may omit them.
 * `registrationExpiry` is the registration certificate's expiry, never the product's.
 */
export const ReferenceRecordSchema = z.object({
  provider: z.string(),
  sourceUrl: z.url(),
  registrationNumber: z.string(),
  brandName: z.string().nullable(),
  genericName: z.string().nullable(),
  strengthForm: z.string().nullable(),
  manufacturer: z.string().nullable(),
  classification: z.string().nullable(),
  registrationExpiry: z.string().nullable(),
  checkedAt: z.iso.datetime(),
});
export type ReferenceRecord = z.infer<typeof ReferenceRecordSchema>;

export const MatchStatusSchema = z.enum([
  'verified',
  'partial',
  'conflicting',
  'ambiguous',
  'no_match',
  'unavailable',
  'not_attempted',
]);
export type MatchStatus = z.infer<typeof MatchStatusSchema>;

export const FieldConflictSchema = z.object({
  key: FieldKeySchema,
  labelValue: z.string(),
  referenceValue: z.string(),
});
export type FieldConflict = z.infer<typeof FieldConflictSchema>;

/** Registry advisory; reported alongside the status, never folded into it. */
export const AdvisorySchema = z.object({
  title: z.string(),
  url: z.url(),
});
export type Advisory = z.infer<typeof AdvisorySchema>;

export const MatchAssessmentSchema = z.object({
  status: MatchStatusSchema,
  matched: z.array(FieldKeySchema),
  conflicting: z.array(FieldConflictSchema),
  missing: z.array(FieldKeySchema),
  candidates: z.array(ReferenceRecordSchema),
  advisories: z.array(AdvisorySchema),
  limitations: z.array(z.string()),
});
export type MatchAssessment = z.infer<typeof MatchAssessmentSchema>;
