/**
 * The cross-language contract test (Go port spec §6.7, plan task G9): the
 * Go API binary, built once and started in mock + fixture mode, validated
 * against the Zod contracts. Run by the root `npm test`.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    include: ['*.test.ts'],
    // `go build` of the API runs in beforeAll; a cold build cache is slow
    hookTimeout: 300_000,
    testTimeout: 30_000,
  },
});
