/**
 * In-memory TTL store for analysis results (spec §3 privacy): results live
 * only in process memory, only long enough for follow-up calls, and are
 * never written to disk. Copies go in and out, so no caller can change a
 * stored result.
 */
import type { AnalysisResult } from '@medilens/contracts';
import { RESULT_TTL_MS } from '../config';

export interface ResultStore {
  readonly ttlMs: number;
  put(r: AnalysisResult): void;
  get(id: string): AnalysisResult | undefined;
}

export function createResultStore(now: () => number, ttlMs = RESULT_TTL_MS): ResultStore {
  const entries = new Map<string, { result: AnalysisResult; expiresAt: number }>();

  const sweep = (t: number): void => {
    for (const [id, e] of entries) if (t >= e.expiresAt) entries.delete(id);
  };

  return {
    ttlMs,
    put(r) {
      const t = now();
      sweep(t);
      entries.set(r.id, { result: structuredClone(r), expiresAt: t + ttlMs });
    },
    get(id) {
      const e = entries.get(id);
      if (e === undefined) return undefined;
      if (now() >= e.expiresAt) {
        entries.delete(id);
        return undefined;
      }
      return structuredClone(e.result);
    },
  };
}
