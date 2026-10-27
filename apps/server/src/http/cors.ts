import type { RequestHandler } from 'express';

/**
 * CORS for exactly one configured origin (CORS_ORIGIN). The Android app does
 * not need CORS; this is only for a browser client such as Expo web. Other
 * origins get no CORS headers at all.
 */
export function corsFor(origin: string): RequestHandler {
  return (req, res, next) => {
    res.vary('Origin');
    if (req.headers.origin !== origin) {
      next();
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    next();
  };
}
