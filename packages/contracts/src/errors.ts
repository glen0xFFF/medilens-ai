import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
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
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** Error response body. Never carries a stack trace. */
export const ErrorBodySchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    requestId: z.string(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
