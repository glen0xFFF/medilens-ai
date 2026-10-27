/** In-memory cache whose entries expire `ttlMs` after they were set. */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

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
    this.entries.set(k, { value: v, expiresAt: this.now() + this.ttlMs });
  }
}
