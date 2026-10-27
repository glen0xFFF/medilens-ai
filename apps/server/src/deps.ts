/**
 * Builds the app's dependencies from the validated config. Live mode wires
 * Muse Spark (reader and answerer) and the PH FDA registry, and prices every
 * Muse Spark completion into the daily spend meter through `onUsage`.
 */
import { randomUUID } from 'node:crypto';
import type { AppDeps, LiveProviders } from './app';
import { userAgent, type AppConfig } from './config';
import type { Logger } from './http/logger';
import { createSpendMeter } from './pipeline/budget';
import { createResultStore } from './pipeline/store';
import {
  createMetaClient,
  createMuseSparkAnswerer,
  createMuseSparkLabelReader,
  type ChatClient,
  type ModelRequestError,
  type ModelUsage,
} from './providers/museSpark';
import { createPhFdaProvider } from './providers/phFda';

export interface CreateDepsOptions {
  logger: Logger;
  now?: () => number;
  /** Test seams; production uses the global fetch and the Meta Model API client. */
  fetch?: typeof fetch;
  chatClient?: ChatClient;
}

export function createAppDeps(config: AppConfig, opts: CreateDepsOptions): AppDeps {
  const now = opts.now ?? Date.now;
  const meter = createSpendMeter(config.dailySpendCapUsd, now);

  let live: LiveProviders | undefined;
  if (config.providerMode === 'live') {
    const key = config.modelApiKey;
    if (key === undefined || key === '') throw new Error('MODEL_API_KEY is required in live mode.');
    const client = opts.chatClient ?? createMetaClient(key);
    const onUsage = (usage: ModelUsage): void => meter.record(usage);
    // final review Minor 12: a wrong key or a 429 is visible in the logs, by
    // error name and HTTP status only; the message can echo request details
    const onError = ({ errorName, status }: ModelRequestError): void => {
      opts.logger.warn({ errorName, status }, 'model request failed');
    };
    live = {
      reader: createMuseSparkLabelReader(client, { onUsage, onError }),
      references: createPhFdaProvider({
        fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
        now,
        userAgent: userAgent(config),
      }),
      answerer: createMuseSparkAnswerer(client, { onUsage, onError }),
    };
  }

  return {
    providerMode: config.providerMode,
    live,
    store: createResultStore(now),
    meter,
    now,
    newId: randomUUID,
    logger: opts.logger,
    corsOrigin: config.corsOrigin,
  };
}
