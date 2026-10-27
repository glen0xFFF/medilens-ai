/**
 * Shared setup for the HTTP tests: an app with an in-memory log sink and
 * counting stub live providers. All label and registry data is synthetic DEMO
 * DATA with fictional product names.
 */
import { ErrorBodySchema, type Answer, type ErrorCode } from '@medilens/contracts';
import { expect } from 'vitest';
import type { Response } from 'supertest';
import { createApp, type AppDeps, type LiveProviders } from '../../src/app';
import { getScenario } from '../../src/demo/scenarios';
import { answerFromLabel } from '../../src/domain/answers';
import { createLogger } from '../../src/http/logger';
import { createSpendMeter, type SpendMeter } from '../../src/pipeline/budget';
import { createResultStore } from '../../src/pipeline/store';
import type { AnswerInput } from '../../src/providers/types';

export const T0 = Date.parse('2026-10-27T08:00:00.000Z');

export const SCENARIO_IDS = [
  's1-clear',
  's2-blurry',
  's3-similar',
  's4-conflict',
  's5-nomatch',
  's6-loose-pill',
  's7-unsupported-question',
  's8-registry-down',
] as const;

export interface StubCalls {
  read: number;
  search: number;
  answer: number;
  answerInputs: AnswerInput[];
}

/** Live providers that never touch the network: they serve the s1 fixture and count calls. */
export function stubLive(overrides: Partial<LiveProviders> = {}): {
  providers: LiveProviders;
  calls: StubCalls;
} {
  const s1 = getScenario('s1-clear');
  if (s1 === undefined) throw new Error('missing s1 fixture');
  const calls: StubCalls = { read: 0, search: 0, answer: 0, answerInputs: [] };
  const base: LiveProviders = {
    reader: {
      read: () => {
        calls.read++;
        return Promise.resolve({
          ok: true,
          label: structuredClone(s1.label),
          model: 'muse-spark-1.3',
        });
      },
    },
    references: {
      search: () => {
        calls.search++;
        return Promise.resolve(structuredClone(s1.reference));
      },
    },
    answerer: {
      answer: (input: AnswerInput): Promise<Answer> => {
        calls.answer++;
        calls.answerInputs.push(input);
        return Promise.resolve(answerFromLabel(input));
      },
    },
  };
  const { reader, references, answerer } = overrides;
  const counted: LiveProviders = {
    reader: reader
      ? {
          read: (imgs, ctx) => {
            calls.read++;
            return reader.read(imgs, ctx);
          },
        }
      : base.reader,
    references: references
      ? {
          search: (q, ctx) => {
            calls.search++;
            return references.search(q, ctx);
          },
        }
      : base.references,
    answerer: answerer
      ? {
          answer: (input, ctx) => {
            calls.answer++;
            calls.answerInputs.push(input);
            return answerer.answer(input, ctx);
          },
        }
      : base.answerer,
  };
  return { providers: counted, calls };
}

export interface TestAppOptions {
  providerMode?: 'demo' | 'live';
  live?: LiveProviders;
  meter?: SpendMeter;
  corsOrigin?: string;
  now?: () => number;
  trustProxy?: number | false;
}

export function makeApp(opts: TestAppOptions = {}) {
  const lines: string[] = [];
  const logger = createLogger({ write: (s: string) => void lines.push(s) });
  const now = opts.now ?? (() => T0);
  let n = 0;
  const deps: AppDeps = {
    providerMode: opts.providerMode ?? 'demo',
    live: opts.live,
    store: createResultStore(now),
    meter: opts.meter ?? createSpendMeter(5, now),
    now,
    newId: () => `result-${++n}`,
    logger,
    corsOrigin: opts.corsOrigin,
    trustProxy: opts.trustProxy ?? false,
  };
  return { app: createApp(deps), deps, lines };
}

/** Asserts a contract error body with the given HTTP status and code, and no stack trace. */
export function expectError(res: Response, status: number, code: ErrorCode): void {
  expect(res.status).toBe(status);
  const parsed = ErrorBodySchema.safeParse(res.body);
  expect(parsed.success).toBe(true);
  expect(res.body.error.code).toBe(code);
  expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  expect(res.text).not.toContain('stack');
  expect(res.text).not.toContain('at ');
}
