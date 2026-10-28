import { MAX_CACHE_ENTRIES } from '../config';

/**
 * In-memory cache whose entries expire `ttlMs` after they were set. It holds
 * at most `maxEntries`: past that, expired entries are swept and then the
 * oldest entry is evicted (final review Minor 15). Setting a key again makes
 * it the newest.
 */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
    private readonly maxEntries: number = MAX_CACHE_ENTRIES,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(k: K): V | undefined {
    const e = this.entries.get(k);
    if (e === undefined) return undefined;
    if (this.now() >= e.expiresAt) {
      this.entries.delete(k);
      return undefined;
    }
    return e.value;
  }

  set(k: K, v: V): void {
    const t = this.now();
    this.entries.delete(k);
    if (this.entries.size >= this.maxEntries) {
      for (const [key, e] of this.entries) if (t >= e.expiresAt) this.entries.delete(key);
    }
    // a Map iterates in insertion order, so the first key is the oldest
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(k, { value: v, expiresAt: t + this.ttlMs });
  }
}
