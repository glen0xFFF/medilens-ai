import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config';
import { createAppDeps } from '../src/deps';
import { getScenario } from '../src/demo/scenarios';
import { assessMatch } from '../src/domain/matcher';
import { createLogger } from '../src/http/logger';
import type { ChatClient } from '../src/providers/museSpark';
import { sharpJpeg } from './helpers/images';

/* Synthetic recorded completions (DEMO DATA, fictional product). No network. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

function fixture(name: string): Body {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/muse/${name}.json`, import.meta.url), 'utf8'),
  ) as Body;
}

/** A fake Meta client that answers every call with `res` and counts the calls. */
function fakeClient(res: Body) {
  const calls: Body[] = [];
  const client = {
    create: (body: Body) => {
      calls.push(body);
      return Promise.resolve(structuredClone(res));
    },
  } as unknown as ChatClient;
  return { client, calls };
}

const T0 = Date.parse('2026-10-27T08:00:00.000Z');
const logger = createLogger({ write: () => undefined });
const LIVE = { PROVIDER_MODE: 'live', MODEL_API_KEY: 'test-key', DAILY_SPEND_CAP_USD: '5' };

describe('createAppDeps', () => {
  test('demo mode builds no live providers', () => {
    const deps = createAppDeps(loadConfig({}), { logger, now: () => T0 });
    expect(deps.providerMode).toBe('demo');
    expect(deps.live).toBeUndefined();
    expect(deps.meter.exhausted()).toBe(false);
  });

  test('live reader usage is priced into the spend meter', async () => {
    const res = fixture('label-ok');
    res.usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 };
    const { client, calls } = fakeClient(res);
    const deps = createAppDeps(loadConfig(LIVE), { logger, now: () => T0, chatClient: client });
    const read = await deps.live?.reader.read([await sharpJpeg()], {});
    expect(read?.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe('muse-spark-1.3');
    expect(deps.meter.spentUsd()).toBeCloseTo(5.5, 10);
    expect(deps.meter.exhausted()).toBe(true);
  });

  test('live answerer usage is priced into the spend meter', async () => {
    const res = fixture('answer-explain-ok');
    res.usage = { prompt_tokens: 2_000_000, completion_tokens: 0, total_tokens: 2_000_000 };
    const { client, calls } = fakeClient(res);
    const deps = createAppDeps(loadConfig(LIVE), { logger, now: () => T0, chatClient: client });
    const s1 = getScenario('s1-clear');
    if (s1 === undefined) throw new Error('missing s1');
    const answer = await deps.live?.answerer.answer(
      {
        label: s1.label,
        match: assessMatch(s1.label, s1.reference),
        question: 'What does "dry place" mean?',
        intent: 'explain_text',
      },
      {},
    );
    expect(answer?.status).toBe('answered');
    expect(calls).toHaveLength(1);
    expect(deps.meter.spentUsd()).toBeCloseTo(2.5, 10);
  });

  test('the registry provider sends the honest User-Agent from the config', async () => {
    const seen: string[] = [];
    const fakeFetch = ((_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('User-Agent') ?? '');
      return Promise.resolve(
        new Response(JSON.stringify({ cdrr: [], fdawebsite: [] }), { status: 200 }),
      );
    }) as typeof fetch;
    const deps = createAppDeps(loadConfig(LIVE), {
      logger,
      now: () => T0,
      fetch: fakeFetch,
      chatClient: fakeClient(fixture('label-ok')).client,
    });
    const r = await deps.live?.references.search({ name: 'Paracelin' }, {});
    expect(r?.kind).toBe('ok');
    expect(seen).toEqual(['MediLensAI/0.1 (+https://github.com/medilens-ai)']);
  });

  test('the spend cap comes from DAILY_SPEND_CAP_USD', () => {
    const deps = createAppDeps(loadConfig({ ...LIVE, DAILY_SPEND_CAP_USD: '0' }), {
      logger,
      now: () => T0,
      chatClient: fakeClient(fixture('label-ok')).client,
    });
    expect(deps.meter.exhausted()).toBe(true);
  });
});
