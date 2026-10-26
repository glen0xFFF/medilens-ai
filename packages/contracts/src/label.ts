import { z } from 'zod';

export const LegibilitySchema = z.enum(['clear', 'partial', 'unreadable']);
export type Legibility = z.infer<typeof LegibilitySchema>;

export const FieldKeySchema = z.enum([
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
export type FieldKey = z.infer<typeof FieldKeySchema>;

/** A field absent from the pack has `value: null`; values are never invented. */
export const LabelFieldSchema = z.object({
  key: FieldKeySchema,
  value: z.string().nullable(),
  legibility: LegibilitySchema,
  evidenceText: z.string().nullable(),
  imageIndex: z.number().int().nonnegative().nullable(),
  notes: z.string().nullable(),
});
export type LabelField = z.infer<typeof LabelFieldSchema>;

export const ImageKindSchema = z.enum(['label', 'loose_pill', 'not_medicine', 'unreadable']);
export type ImageKind = z.infer<typeof ImageKindSchema>;

export const ExtractedLabelSchema = z.object({
  imageKind: ImageKindSchema,
  fields: z.array(LabelFieldSchema),
  rawText: z.string(),
  warnings: z.array(z.string()),
});
export type ExtractedLabel = z.infer<typeof ExtractedLabelSchema>;
