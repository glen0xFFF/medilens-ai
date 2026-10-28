/**
 * Binds the app to its port. Express 5's `app.listen(port, cb)` also
 * registers `cb` as a once-listener on the server's 'error' event, so a bind
 * failure (EADDRINUSE, EACCES) arrives here as the callback's argument. It is
 * logged as fatal and ends the process with code 1, so a supervisor sees the
 * failure instead of a false 'listening' line and a clean exit.
 */
import type { Server } from 'node:http';
import type { Express } from 'express';
import type { ProviderMode } from '../config';
import type { Logger } from './logger';

export interface ListenOptions {
  port: number;
  providerMode: ProviderMode;
  logger: Logger;
  /** Ends the process; `process.exit` in production, a spy in tests. */
  exit: (code: number) => void;
}

export function startListening(app: Express, opts: ListenOptions): Server {
  const { port, providerMode, logger, exit } = opts;
  return app.listen(port, (err?: Error) => {
    if (err !== undefined) {
      // name and errno code only: the message carries nothing a supervisor needs
      logger.fatal(
        { errorName: err.name, code: (err as NodeJS.ErrnoException).code, port },
        'listen failed',
      );
      exit(1);
      return;
    }
    logger.info({ port, providerMode }, 'listening');
  });
}
