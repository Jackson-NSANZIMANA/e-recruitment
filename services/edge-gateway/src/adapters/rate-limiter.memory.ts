// ══════════════════════════════════════════════════════════════════
// edge-gateway — In-memory fixed-window rate limiter (dev / selfchecks ONLY)
//
// Per-process, so N replicas permit N times the configured rate. That is why
// main.ts refuses to boot this adapter under NODE_ENV=production: the shared
// Postgres adapter (rate-limiter.pg.ts) is the production implementation.
//
// Keys are used as map indexes, so callers pass already-hashed target keys
// (see adapters/http/rate-limit.ts). A National ID must not sit in process
// memory as a plaintext index — a heap dump is a real disclosure channel.
// ══════════════════════════════════════════════════════════════════

import type { RateLimitCheck, RateLimiter } from '../ports/rate-limiter.js';

const WINDOW_MS = 60_000;
/** Above this many live buckets, the sweep runs on write instead of only on timer. */
const SWEEP_THRESHOLD = 10_000;

interface Bucket {
  count: number;
  windowStartedAt: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  readonly store = 'memory' as const;
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  async check(key: string, limitPerMinute: number): Promise<RateLimitCheck> {
    const now = this.#now();
    if (this.#buckets.size > SWEEP_THRESHOLD) this.#sweepAt(now);

    const existing = this.#buckets.get(key);
    if (existing === undefined || now - existing.windowStartedAt >= WINDOW_MS) {
      this.#buckets.set(key, { count: 1, windowStartedAt: now });
      return { allowed: true, remainingTokens: Math.max(0, limitPerMinute - 1), retryAfterSeconds: 0 };
    }
    existing.count += 1;
    if (existing.count > limitPerMinute) {
      const elapsed = now - existing.windowStartedAt;
      return {
        allowed: false,
        remainingTokens: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1_000)),
      };
    }
    return { allowed: true, remainingTokens: limitPerMinute - existing.count, retryAfterSeconds: 0 };
  }

  async activeBuckets(): Promise<number> {
    return this.#buckets.size;
  }

  async sweep(now: Date): Promise<number> {
    return this.#sweepAt(now.getTime());
  }

  #sweepAt(now: number): number {
    let removed = 0;
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.windowStartedAt >= WINDOW_MS) {
        this.#buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
