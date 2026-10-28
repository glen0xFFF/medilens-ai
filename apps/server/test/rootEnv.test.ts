import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { ROOT_ENV_FILE, loadRootEnv } from '../src/rootEnv';

const HERE = dirname(fileURLToPath(import.meta.url));
const VARS = ['MEDILENS_TEST_FROM_FILE', 'MEDILENS_TEST_ALREADY_SET'] as const;
let dir: string | undefined;

afterEach(() => {
  for (const v of VARS) delete process.env[v];
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('final review Minor 30: the repo-root .env is loaded by the server and the scripts', () => {
  test('ROOT_ENV_FILE is the .env at the repository root', () => {
    expect(resolve(ROOT_ENV_FILE)).toBe(resolve(HERE, '../../../.env'));
  });

  test('loads unset variables from the file; variables already set win', () => {
    dir = mkdtempSync(join(tmpdir(), 'medilens-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'MEDILENS_TEST_FROM_FILE=from-file\nMEDILENS_TEST_ALREADY_SET=from-file\n');
    process.env.MEDILENS_TEST_ALREADY_SET = 'from-env';
    expect(loadRootEnv(file)).toBe(true);
    expect(process.env.MEDILENS_TEST_FROM_FILE).toBe('from-file');
    expect(process.env.MEDILENS_TEST_ALREADY_SET).toBe('from-env');
  });

  test('a missing file is not an error', () => {
    expect(loadRootEnv(join(tmpdir(), 'medilens-no-such-dir', '.env'))).toBe(false);
  });

  // The scripts run main() on import, so this checks the wiring in their
  // source: the root .env is loaded before MODEL_API_KEY is read.
  test.each(['scripts/smoke-live.ts', 'scripts/eval-labels.ts', 'src/server.ts'])(
    '%s loads the root .env before reading the environment',
    (path) => {
      const source = readFileSync(resolve(HERE, '..', path), 'utf8');
      const load = source.indexOf('loadRootEnv()');
      expect(load).toBeGreaterThan(-1);
      const firstRead = source.search(/process\.env\.[A-Z_]+|loadConfig\(process\.env\)/);
      expect(firstRead).toBeGreaterThan(load);
    },
  );
});
