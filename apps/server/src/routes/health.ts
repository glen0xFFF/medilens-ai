import { Router } from 'express';
import type { AppDeps } from '../app';
import { APP_VERSION } from '../config';

/** GET /health: liveness plus which providers scanned results use. Not rate limited. */
export function healthRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: APP_VERSION, providerMode: deps.providerMode });
  });
  return router;
}
