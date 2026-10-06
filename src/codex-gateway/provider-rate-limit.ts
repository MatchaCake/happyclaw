/** Fixed windows keyed only by authenticated provider IDs, never bearer keys. */
export class CodexProviderRateLimiter {
  private readonly counters = new Map<
    string,
    { windowStart: number; count: number }
  >();

  constructor(
    private readonly capacity = 1024,
    private readonly maxRequests = 120,
    private readonly windowMs = 60_000,
  ) {}

  get size(): number {
    return this.counters.size;
  }

  isLimited(providerId: string, now = Date.now()): boolean {
    const current = this.counters.get(providerId);
    if (current && now - current.windowStart < this.windowMs) {
      current.count += 1;
      return current.count > this.maxRequests;
    }
    this.counters.delete(providerId);
    // Map insertion order is window-start order. Remove only expired heads,
    // once each, rather than scanning every live counter for every new ID.
    while (this.counters.size) {
      const [key, oldest] = this.counters.entries().next().value!;
      if (now - oldest.windowStart < this.windowMs) break;
      this.counters.delete(key);
    }
    // Do not evict live counters: that would let active providers reset their
    // budgets. A full table fails closed until a window expires.
    if (this.counters.size >= this.capacity) return true;
    this.counters.set(providerId, { windowStart: now, count: 1 });
    return false;
  }
}
