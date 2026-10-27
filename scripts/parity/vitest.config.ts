/**
 * The parity:record vitest config: the whole server suite plus the probe
 * corpora (probes.parity.ts) and the recorder's own tests, with setup.ts
 * recording every exported domain call. Run through scripts/parity/record.ts,
 * which sets PARITY_RAW_DIR and turns the raw output into
 * fixtures/parity/*.jsonl.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(here, '../../apps/server');

export default defineConfig({
  root: server,
  test: {
    include: [
      'test/**/*.test.ts',
      '../../scripts/parity/*.test.ts',
      '../../scripts/parity/probes.parity.ts',
    ],
    setupFiles: [resolve(here, 'setup.ts')],
  },
});
