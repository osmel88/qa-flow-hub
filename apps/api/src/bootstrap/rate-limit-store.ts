import type { FastifyRateLimitOptions, FastifyRateLimitStore } from '@fastify/rate-limit';

interface Window {
  count: number;
  startedAt: number;
}

/** Same bound as the plugin's default store: one entry per recent client. */
const MAX_TRACKED_KEYS = 5_000;

/**
 * Fixed-window counters per key, in process memory.
 *
 * It replaces the plugin's default store for one reason: that store hands the
 * plugin its live counter object, and the plugin reads it only after an
 * `await`. When a burst arrives together, every request reads the counter
 * after all of them incremented it, so all of them see the final count and are
 * all rejected — a legitimate client sending `max + 1` parallel requests got
 * nothing. Here each request receives the count as it was at its own increment.
 */
export class SnapshotRateLimitStore implements FastifyRateLimitStore {
  private readonly windows = new Map<string, Window>();

  /** The plugin constructs the store with its options; none of them apply here. */
  constructor(
    _options: FastifyRateLimitOptions = {},
    private readonly now: () => number = Date.now,
  ) {}

  incr(
    key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
    timeWindow = 60_000,
  ): void {
    const now = this.now();
    let window = this.windows.get(key);
    if (window === undefined || window.startedAt + timeWindow <= now) {
      window = { count: 0, startedAt: now };
    }
    window.count += 1;

    // Re-inserted so the Map's insertion order is least-recently-used first.
    this.windows.delete(key);
    this.windows.set(key, window);
    if (this.windows.size > MAX_TRACKED_KEYS) {
      const oldest = this.windows.keys().next().value;
      if (oldest !== undefined) {
        this.windows.delete(oldest);
      }
    }

    callback(null, { current: window.count, ttl: window.startedAt + timeWindow - now });
  }

  child(): FastifyRateLimitStore {
    return new SnapshotRateLimitStore({}, this.now);
  }
}
