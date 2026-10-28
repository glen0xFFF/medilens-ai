/**
 * vitest setup file used ONLY by the parity:record config
 * (scripts/parity/vitest.config.ts). It replaces each domain module with a
 * recording copy (recorder.ts `wrapModule`) for every test file, so the full
 * server suite and the probe corpora record each exported domain call. The
 * server's own `npm test` never loads this file, and no production source is
 * changed.
 *
 * Calls between domain modules go through the mocked exports too (for example
 * matcher.ts calling parseStrength), so those calls are recorded as well.
 * Calls inside one module use its local bindings and are not.
 */
import { afterAll, vi } from 'vitest';
import { flush } from './recorder';

vi.mock('../../apps/server/src/domain/parsers', async (importOriginal) =>
  (await import('./recorder')).wrapModule('parsers', await importOriginal()),
);
vi.mock('../../apps/server/src/domain/matcher', async (importOriginal) =>
  (await import('./recorder')).wrapModule('matcher', await importOriginal()),
);
vi.mock('../../apps/server/src/domain/safety', async (importOriginal) =>
  (await import('./recorder')).wrapModule('safety', await importOriginal()),
);
vi.mock('../../apps/server/src/domain/summary', async (importOriginal) =>
  (await import('./recorder')).wrapModule('summary', await importOriginal()),
);
vi.mock('../../apps/server/src/domain/answers', async (importOriginal) =>
  (await import('./recorder')).wrapModule('answers', await importOriginal()),
);

afterAll(() => {
  flush();
});
