/**
 * Structured JSON logs (spec §5.1). One line per request with method, path,
 * status, duration and request id, and nothing else: no bodies, no query
 * strings, no headers, so image bytes, label text and questions never reach
 * the logs. The redact paths are a second line of defence for anything that
 * is ever logged with an object.
 */
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import pino, { type DestinationStream, type Logger } from 'pino';

export const REDACT_PATHS = [
  'req.headers.authorization',
  '*.rawText',
  '*.question',
  '*.evidenceText',
];

export type { Logger };

export function createLogger(destination?: DestinationStream): Logger {
  // base: undefined drops pino's default pid and hostname from every line
  // (final review Minor 16): neither helps a reader, and the host name can
  // identify the machine.
  const options = { redact: REDACT_PATHS, base: undefined };
  return destination === undefined ? pino(options) : pino(options, destination);
}

/** The id of the current request, set by `requestContext`. */
export function requestIdOf(locals: Record<string, unknown>): string {
  return typeof locals.requestId === 'string' ? locals.requestId : 'unknown';
}

/**
 * Gives every request a fresh id (a client-sent X-Request-Id is ignored, so
 * nothing from the client reaches a log line through it), returns it as
 * X-Request-Id, and logs one line when the response is sent.
 */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const requestId = randomUUID();
    const started = performance.now();
    // req.path has no query string; captured now, before any router rewrites req.url
    const { method, path } = req;
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      logger.info(
        {
          requestId,
          method,
          path,
          status: res.statusCode,
          durationMs: Math.round((performance.now() - started) * 10) / 10,
        },
        'request',
      );
    });
    next();
  };
}
