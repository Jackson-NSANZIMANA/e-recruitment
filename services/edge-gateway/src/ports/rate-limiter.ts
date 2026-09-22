// ══════════════════════════════════════════════════════════════════
// edge-gateway — Rate limiter port
//
// The abstract interface for rate limiting. The application layer uses this
// to enforce per-client and per-target rate limits without coupling to the
// in-memory fixed-window implementation or any concrete algorithm.
//
// Implementations: adapters/fixed-window-rate-limiter.ts (in-memory)
// Future: adapters/redis-rate-limiter.ts (distributed)
// ══════════════════════════════════════════════════════════════════

/**
 * Result of a rate limit check. The application layer inspects `allowed` and
 * throws RateLimitExceededError if false, using `retryAfterSeconds` for the
 * HTTP Retry-After header.
 */
export interface RateLimitCheck {
  /** Whether the request is allowed (under the limit). */
  readonly allowed: boolean;
  /** How many tokens remain in the bucket (0 if denied). */
  readonly remainingTokens: number;
  /** How many seconds until the bucket resets (0 if allowed). */
  readonly retryAfterSeconds: number;
}

/**
 * Rate limiter port. The application layer uses this to enforce rate limits
 * without coupling to the fixed-window algorithm, Redis, or any concrete
 * implementation.
 *
 * Buckets are identified by string keys (e.g., "client:192.0.2.1:officerLogin"
 * or "target:handle_hash:officerLogin"). The application layer builds the keys
 * using domain knowledge (operation id, client ip, target handle hash).
 */
export interface RateLimiter {
  /**
   * Check whether a request is within the rate limit for the given bucket.
   * Consumes a token if allowed; returns denial details if over the limit.
   *
   * @param bucketKey Unique bucket identifier
   * @param limit Maximum requests per window (e.g., 5 per minute)
   * @returns Rate limit check result
   */
  check(bucketKey: string, limit: number): RateLimitCheck;

  /**
   * Return the number of active buckets (for observability only). No detail
   * about which buckets or their keys — just a count.
   *
   * @returns Number of active rate limit buckets
   */
  size(): number;
}
