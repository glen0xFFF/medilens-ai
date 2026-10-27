/**
 * Daily spend cap for live Muse Spark calls (spec §5.1, public live access).
 * Each completion's usage is priced and summed per UTC day; the routes check
 * `exhausted()` before any live model call and answer 503
 * LIVE_BUDGET_EXHAUSTED instead. In memory only: a restart starts the day at
 * zero again.
 */

/** USD per 1M input tokens. */
export const INPUT_USD_PER_MTOK = 1.25;
/** USD per 1M output tokens; hidden reasoning is billed as output. */
export const OUTPUT_USD_PER_MTOK = 4.25;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface SpendMeter {
  record(usage: TokenUsage): void;
  exhausted(): boolean;
  spentUsd(): number;
}

/** A token count that can be priced; anything else counts as zero. */
function tokens(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function createSpendMeter(capUsd: number, now: () => number): SpendMeter {
  let day = Math.floor(now() / DAY_MS);
  // Summed in micro-dollars (USD per 1M tokens = micro-dollars per token):
  // token counts times quarter-dollar prices add up exactly, with no drift
  // around the cap.
  let spentMicro = 0;
  const capMicro = capUsd * 1_000_000;

  /** Starts a new total when the UTC day has changed since the last call. */
  const roll = (): void => {
    const today = Math.floor(now() / DAY_MS);
    if (today !== day) {
      day = today;
      spentMicro = 0;
    }
  };

  return {
    record(usage) {
      roll();
      spentMicro +=
        tokens(usage.prompt_tokens) * INPUT_USD_PER_MTOK +
        tokens(usage.completion_tokens) * OUTPUT_USD_PER_MTOK;
    },
    exhausted() {
      roll();
      return spentMicro >= capMicro;
    },
    spentUsd() {
      roll();
      return spentMicro / 1_000_000;
    },
  };
}
