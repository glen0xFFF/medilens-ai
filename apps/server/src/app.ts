/**
 * The Express app (spec §5.1). Everything it needs is injected, so tests run
 * it with stub live providers and an in-memory log sink; server.ts builds the
 * real dependencies from the environment.
 *
 * PROVIDER_MODE governs only POST /labels/analyze (and so which answerer a
 * scanned result gets); /demo/* always uses the fixture providers, so one
 * backend serves both the eight scenarios and live scans.
 */
import express, { Router, type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import { RATE_LIMIT_PER_WINDOW, RATE_LIMIT_WINDOW_MS, type ProviderMode } from './config';
import { corsFor } from './http/cors';
import { errorHandler, notFound, sendError } from './http/errors';
import { requestContext, type Logger } from './http/logger';
import type { SpendMeter } from './pipeline/budget';
import type { ResultStore } from './pipeline/store';
import { FixtureAnswerer, FixtureLabelReader, FixtureReferenceProvider } from './providers/fixture';
import type { LabelReader, QuestionAnswerer, ReferenceProvider } from './providers/types';
import { demoRouter } from './routes/demo';
import { healthRouter } from './routes/health';
import { labelsRouter } from './routes/labels';
import { questionsRouter } from './routes/questions';
import { referencesRouter } from './routes/references';

export interface LiveProviders {
  reader: LabelReader;
  references: ReferenceProvider;
  answerer: QuestionAnswerer;
}

export interface AppDeps {
  providerMode: ProviderMode;
  /** Muse Spark + PH FDA; required in live mode, unused in demo mode. */
  live: LiveProviders | undefined;
  store: ResultStore;
  meter: SpendMeter;
  now: () => number;
  newId: () => string;
  logger: Logger;
  corsOrigin: string | undefined;
  /** Express `trust proxy` hop count, or false (final review I4; config TRUST_PROXY). */
  trustProxy: number | false;
}

/** What the routers share: the app deps plus the always-available fixture providers. */
export interface RouteContext {
  deps: AppDeps;
  fixtures: LiveProviders;
}

export function createApp(deps: AppDeps): Express {
  if (deps.providerMode === 'live' && deps.live === undefined) {
    throw new Error('Live mode needs live providers.');
  }
  const ctx: RouteContext = {
    deps,
    fixtures: {
      reader: new FixtureLabelReader(),
      references: new FixtureReferenceProvider(),
      answerer: new FixtureAnswerer(),
    },
  };

  const app = express();
  app.disable('x-powered-by');
  // Behind a host's proxy every request arrives from the proxy's address; with
  // the hop count trusted, req.ip is the client's, so the rate limit below is
  // per client and not one bucket shared by everyone (final review I4).
  app.set('trust proxy', deps.trustProxy);
  app.use(requestContext(deps.logger));
  if (deps.corsOrigin !== undefined) app.use(corsFor(deps.corsOrigin));

  app.use(healthRouter(deps));

  // 30 requests per minute per IP across every /api route (in memory, per app).
  app.use(
    '/api',
    rateLimit({
      windowMs: RATE_LIMIT_WINDOW_MS,
      limit: RATE_LIMIT_PER_WINDOW,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) => sendError(res, 429, 'RATE_LIMITED'),
    }),
  );
  const api = Router();
  api.use(labelsRouter(ctx));
  api.use(referencesRouter(ctx));
  api.use(demoRouter(ctx));
  api.use(questionsRouter());
  app.use('/api/v1', api);

  app.use(notFound);
  app.use(errorHandler(deps.logger));
  return app;
}
