import { z } from 'zod';
import { FieldKeySchema } from './label';

export const AnswerSchema = z.object({
  status: z.enum(['answered', 'refused', 'unclear']),
  text: z.string(),
  spokenChunks: z.array(z.string()),
  citedFields: z.array(FieldKeySchema),
  safetyNotice: z.string().nullable(),
});
export type Answer = z.infer<typeof AnswerSchema>;

export const ExplainRequestSchema = z.object({
  question: z.string().trim().min(1).max(300),
});
export type ExplainRequest = z.infer<typeof ExplainRequestSchema>;
