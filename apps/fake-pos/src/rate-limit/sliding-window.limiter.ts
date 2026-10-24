/**
 * Allows at most `maxRequests` per `windowMs` for each key (here: each restaurant).
 * Keeps the timestamps of accepted requests and forgets the ones older than the window.
 *
 * Only accepted requests are counted: a client that gets a 429 and backs off is not punished further.
 */
export class SlidingWindowLimiter {
  private readonly accepted = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    // Injected so tests can move time without waiting.
    private readonly now: () => number = Date.now,
  ) {}

  tryAcquire(key: string): boolean {
    const now = this.now();
    const recent = (this.accepted.get(key) ?? []).filter((at) => at > now - this.windowMs);

    if (recent.length >= this.maxRequests) {
      this.accepted.set(key, recent);
      return false;
    }

    recent.push(now);
    this.accepted.set(key, recent);
    return true;
  }

  reset(): void {
    this.accepted.clear();
  }
}
