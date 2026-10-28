import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

interface PackageJson {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageJson;

describe('final review I4: npm start runs on a production install', () => {
  // A host that installs with --omit=dev, or prunes dev dependencies after the
  // build, must still be able to run the start script.
  test('the start script runner is a runtime dependency, not a devDependency', () => {
    const runner = (pkg.scripts.start ?? '').split(' ')[0] ?? '';
    expect(runner).toBe('tsx');
    expect(pkg.dependencies[runner]).toBeDefined();
    expect(pkg.devDependencies?.[runner]).toBeUndefined();
  });
});
