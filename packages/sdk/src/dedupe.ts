/**
 * Event keys seen recently, so a redelivery of the same event within one isolate or object is
 * skipped. Best-effort: a new Worker isolate starts empty. The socket host keeps its own record
 * in storage.
 */
export class SeenEvents {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 2_000,
  ) {}

  /** True when the key is new, and marks it seen. */
  claim(key: string, now = Date.now()): boolean {
    const at = this.seen.get(key);
    if (at !== undefined && now - at < this.ttlMs) return false;
    this.seen.delete(key);
    this.seen.set(key, now);
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }

  /** Forgets a key, so its redelivery runs. */
  release(key: string): void {
    this.seen.delete(key);
  }
}
