/**
 * Error responses (spec §5.2): always `{error: {code, message, requestId}}`
 * with a fixed message per code. Never a stack trace and never the text of
 * an unexpected error, which could carry label text or provider detail.
 */
import type { ErrorBody, ErrorCode } from '@medilens/contracts';
import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import multer from 'multer';
import { PipelineError } from '../pipeline/analyze';
import { requestIdOf, type Logger } from './logger';

/** A client error raised by a route, with its own message. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function validationFailed(message: string): HttpError {
  return new HttpError(400, 'VALIDATION_FAILED', message);
}

/** Spoken-friendly messages; none may contain a stack-like "at " sequence. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_IMAGE: 'Please send a JPEG, PNG or WebP photo.',
  IMAGE_TOO_LARGE: 'Each photo must be 8 MB or smaller.',
  LIVE_BUDGET_EXHAUSTED: 'Live scanning is paused for today. Please use Demo Mode instead.',
  LABEL_UNREADABLE: "I couldn't read this label. Please take another photo.",
  OCR_FAILED: "I couldn't read the label right now. Please try again.",
  REFERENCE_UNAVAILABLE: "I couldn't check the FDA registry right now.",
  NO_RELIABLE_MATCH: 'No matching registration found.',
  CONFLICTING_MATCH: 'Some details on the label do not match the registry.',
  UNSUPPORTED_REQUEST: 'I can only read and explain the printed text on this label.',
  RATE_LIMITED: 'Too many requests. Please wait a minute and try again.',
  NOT_FOUND: 'This scan result has expired or does not exist. Please scan again.',
  VALIDATION_FAILED: 'The request is not valid.',
  INTERNAL_ERROR: 'Something went wrong. Please try again.',
};

/** HTTP status for each pipeline error code (Task 10 ruling); anything else is a 500. */
const PIPELINE_STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_IMAGE: 415,
  IMAGE_TOO_LARGE: 413,
  OCR_FAILED: 502,
  NOT_FOUND: 404,
  LIVE_BUDGET_EXHAUSTED: 503,
  RATE_LIMITED: 429,
  VALIDATION_FAILED: 400,
};

export function sendError(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string = ERROR_MESSAGES[code],
): void {
  const body: ErrorBody = { error: { code, message, requestId: requestIdOf(res.locals) } };
  res.status(status).json(body);
}

/** Unknown route. */
export const notFound: RequestHandler = (_req, res) => {
  sendError(res, 404, 'NOT_FOUND', 'Not found.');
};

/** True for body-parser's client errors (malformed JSON, body too large, bad charset). */
function isBodyParserError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { type?: unknown; status?: unknown };
  return (
    typeof e.type === 'string' && typeof e.status === 'number' && e.status >= 400 && e.status < 500
  );
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof HttpError) {
      sendError(res, err.status, err.code, err.message);
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') sendError(res, 413, 'IMAGE_TOO_LARGE');
      else sendError(res, 400, 'VALIDATION_FAILED', 'Send 1 to 3 photos in the "images" field.');
      return;
    }
    if (isBodyParserError(err)) {
      sendError(
        res,
        400,
        'VALIDATION_FAILED',
        'The request body is not valid JSON of up to 16 kB.',
      );
      return;
    }
    if (err instanceof PipelineError) {
      const status = PIPELINE_STATUS[err.code];
      if (status !== undefined) {
        sendError(res, status, err.code);
        return;
      }
    }
    // Only the error's class name is logged: its message could carry label text.
    logger.error(
      {
        requestId: requestIdOf(res.locals),
        errorName: err instanceof Error ? err.name : typeof err,
      },
      'unhandled error',
    );
    sendError(res, 500, 'INTERNAL_ERROR');
  };
}
