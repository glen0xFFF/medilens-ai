import { describe, expect, test } from 'vitest';
import { createSpendMeter } from '../../src/pipeline/budget';

const at = (iso: string): number => Date.parse(iso);

function clock(iso: string) {
  let t = at(iso);
  return {
    now: () => t,
    set: (next: string) => {
      t = at(next);
    },
  };
}

describe('createSpendMeter', () => {
  test('prices 1M input + 1M output tokens at $5.50', () => {
    const m = createSpendMeter(100, () => at('2026-10-27T10:00:00.000Z'));
    m.record({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    expect(m.spentUsd()).toBeCloseTo(5.5, 10);
  });

  test('prices input at $1.25 and output (reasoning included) at $4.25 per 1M tokens', () => {
    const m = createSpendMeter(100, () => at('2026-10-27T10:00:00.000Z'));
    m.record({ prompt_tokens: 2_000_000, completion_tokens: 0 });
    expect(m.spentUsd()).toBeCloseTo(2.5, 10);
    m.record({ prompt_tokens: 0, completion_tokens: 2_000_000 });
    expect(m.spentUsd()).toBeCloseTo(2.5 + 8.5, 10);
  });

  test('a fresh meter has spent nothing and is not exhausted', () => {
    const m = createSpendMeter(5, () => at('2026-10-27T10:00:00.000Z'));
    expect(m.spentUsd()).toBe(0);
    expect(m.exhausted()).toBe(false);
  });

  test('is exhausted once the day spend reaches the cap, not before', () => {
    const m = createSpendMeter(5, () => at('2026-10-27T10:00:00.000Z'));
    m.record({ prompt_tokens: 3_999_999, completion_tokens: 0 });
    expect(m.exhausted()).toBe(false);
    m.record({ prompt_tokens: 1, completion_tokens: 0 });
    expect(m.spentUsd()).toBeCloseTo(5, 10);
    expect(m.exhausted()).toBe(true);
  });

  test('resets after UTC midnight', () => {
    const c = clock('2026-10-27T23:59:59.999Z');
    const m = createSpendMeter(5, c.now);
    m.record({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    expect(m.exhausted()).toBe(true);
    c.set('2026-10-28T00:00:00.000Z');
    expect(m.spentUsd()).toBe(0);
    expect(m.exhausted()).toBe(false);
    m.record({ prompt_tokens: 1_000_000, completion_tokens: 0 });
    expect(m.spentUsd()).toBeCloseTo(1.25, 10);
  });

  test('does not reset at Manila midnight (16:00 UTC), only at UTC midnight', () => {
    const c = clock('2026-10-27T15:59:00.000Z');
    const m = createSpendMeter(5, c.now);
    m.record({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    c.set('2026-10-27T16:01:00.000Z');
    expect(m.spentUsd()).toBeCloseTo(5.5, 10);
    expect(m.exhausted()).toBe(true);
  });

  test('a cap of 0 disables live calls', () => {
    const m = createSpendMeter(0, () => at('2026-10-27T10:00:00.000Z'));
    expect(m.exhausted()).toBe(true);
  });

  test('ignores negative or non-finite token counts instead of corrupting the total', () => {
    const m = createSpendMeter(5, () => at('2026-10-27T10:00:00.000Z'));
    m.record({ prompt_tokens: 1_000_000, completion_tokens: 0 });
    m.record({ prompt_tokens: Number.NaN, completion_tokens: -5 });
    m.record({ prompt_tokens: Number.POSITIVE_INFINITY, completion_tokens: 0 });
    expect(m.spentUsd()).toBeCloseTo(1.25, 10);
  });
});
