/**
 * Entry point: environment -> config -> dependencies -> listen. Runs under
 * tsx (extensionless imports). Reads the repo-root .env when present; real
 * environment variables take precedence over it. Live mode without
 * MODEL_API_KEY exits here, before listening (spec §4.2).
 */
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { loadConfig, type AppConfig } from './config';
import { createAppDeps } from './deps';
import { createLogger } from './http/logger';

const ROOT_ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));

const logger = createLogger();

try {
  process.loadEnvFile(ROOT_ENV_FILE);
} catch {
  // no .env file: the process environment alone is used
}

let config: AppConfig;
try {
  config = loadConfig(process.env);
} catch (err) {
  // the message names invalid variables, never their values
  logger.fatal({ reason: err instanceof Error ? err.message : 'invalid config' }, 'startup failed');
  process.exit(1);
}

const app = createApp(createAppDeps(config, { logger }));
const server = app.listen(config.port, () => {
  logger.info({ port: config.port, providerMode: config.providerMode }, 'listening');
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
