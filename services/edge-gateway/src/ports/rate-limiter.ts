// ══════════════════════════════════════════════════════════════════
// edge-gateway — Rate limiter port
//
// On officer login, applicant OTP and NIDA identity checks the limiter is a
// CORRECTNESS control, not hardening: a 202 whose body reveals nothing is still
// an enumeration oracle by volume and timing without it.
//
// THE PORT IS ASYNC. The previous port was synchronous, which made a SHARED
// counter unimplementable behind it — and a per-process counter means N
// replicas permit N times the configured rate (audit 1.6, ADR-024 residual).
// Async is what lets the Postgres adapter exist at all.
//
// Implementations:
//   adapters/rate-limiter.pg.ts      shared across replicas (production)
//   adapters/rate-limiter.memory.ts  single process (dev, selfchecks)
//
// main.ts REFUSES to boot the memory adapter under NODE_ENV=production.
// ══════════════════════════════════════════════════════════════════

/** The verdict for one bucket. */
export interface RateLimitCheck {
  readonly allowed: boolean;
  /** Tokens left in this window (0 when denied). */
  readonly remainingTokens: number;
  /** Seconds until the window resets (0 when allowed). */
  readonly retryAfterSeconds: number;
}

/**
 * Fixed-window, per-minute limiter.
 *
 * Bucket keys are built by the caller from domain knowledge (operation id plus
 * a keyed hash of the target, the trusted client address, or the session id).
 * Adapters must treat keys as SENSITIVE: a client key carries an IP address and
 * a target key is derived from a National ID. The Postgres adapter therefore
 * stores only a keyed hash of the key.
 */
export interface RateLimiter {
  /** Which backing store this limiter uses. Read by the production boot guard. */
  readonly store: 'memory' | 'postgres';

  /** Count one attempt against `bucketKey`; deny once the window holds more than `limitPerMinute`. */
  check(bucketKey: string, limitPerMinute: number): Promise<RateLimitCheck>;

  /** Live bucket count, for the observability line only. No keys are ever exposed. */
  activeBuckets(now: Date): Promise<number>;

  /** Drop windows that ended before `now`. Returns the number removed. */
  sweep(now: Date): Promise<number>;
}

/** The limiter's own backing store is unreachable. Fails CLOSED (503), never open. */
export class RateLimiterUnavailableError extends Error {
  constructor(options?: { readonly cause?: unknown }) {
    super('Rate limiter store unavailable', options);
    this.name = 'RateLimiterUnavailableError';
  }
}
