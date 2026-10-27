/**
 * In-memory TTL store for analysis results (spec §3 privacy): results live
 * only in process memory, only long enough for follow-up calls, and are
 * never written to disk. Copies go in and out, so no caller can change a
 * stored result. At most `maxEntries` results are held: past that, expired
 * results are swept and then the oldest is evicted (final review Minor 15).
 */
import type { AnalysisResult } from '@medilens/contracts';
import { MAX_CACHE_ENTRIES, RESULT_TTL_MS } from '../config';

export interface ResultStore {
  readonly ttlMs: number;
  /** Results currently held, expired ones included until the next sweep. */
  readonly size: number;
  put(r: AnalysisResult): void;
  get(id: string): AnalysisResult | undefined;
}

export function createResultStore(
  now: () => number,
  ttlMs = RESULT_TTL_MS,
  maxEntries = MAX_CACHE_ENTRIES,
): ResultStore {
  const entries = new Map<string, { result: AnalysisResult; expiresAt: number }>();

  const sweep = (t: number): void => {
    for (const [id, e] of entries) if (t >= e.expiresAt) entries.delete(id);
  };

  return {
    ttlMs,
    get size() {
      return entries.size;
    },
    put(r) {
      const t = now();
      sweep(t);
      entries.delete(r.id);
      // a Map iterates in insertion order, so the first id is the oldest
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
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
