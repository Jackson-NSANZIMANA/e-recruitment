// ══════════════════════════════════════════════════════════════════
// edge-gateway — Rate-limit enforcement at the HTTP boundary
//
// TWO BUCKETS PER CREDENTIAL ATTEMPT, both must pass:
//
//   target  the thing being probed — a login handle, or a keyed hash of the
//           submitted National ID. This is the bucket that actually stops
//           enumeration: a per-target cap makes each target expensive
//           regardless of where the traffic comes from.
//   client  the caller. Derived from `x-forwarded-for` using a CONFIGURED hop
//           count; with EDGE_TRUSTED_PROXY_HOPS=0 every caller shares ONE
//           bucket. That default is the strictest behaviour available: a
//           spoofable per-client key would be worse than a global cap.
//
// Authenticated routes use a per-SESSION bucket instead of the client one: a
// session is a strong identifier the caller cannot spoof.
//
// The limiter itself is a port (ports/rate-limiter.ts). This module only builds
// keys and turns a verdict into the contract's 429 / fail-closed 503.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type RequestContext } from '@usrp/shared-http';
import { hmacSha256Hex } from '@usrp/shared-security';
import { RateLimiterUnavailableError, type RateLimiter } from '../../ports/rate-limiter.js';

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The client bucket key. `x-forwarded-for` is a list the CLIENT can prepend
 * to; only the last `trustedProxyHops` entries were written by infrastructure
 * we control. With hops=0 nothing is trusted and every caller shares one bucket.
 */
export function clientBucketKey(ctx: RequestContext, trustedProxyHops: number): string {
  if (trustedProxyHops <= 0) return 'client:untrusted-shared';
  const raw = headerValue(ctx.headers['x-forwarded-for']);
  if (raw === undefined) return 'client:untrusted-shared';
  const hops = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= 64);
  if (hops.length < trustedProxyHops) return 'client:untrusted-shared';
  const candidate = hops[hops.length - trustedProxyHops];
  return candidate === undefined ? 'client:untrusted-shared' : `client:${candidate}`;
}

/** A hashed target key. The plaintext target never becomes a bucket key. */
export function targetBucketKey(hmacKey: string, operation: string, target: string): string {
  return `target:${operation}:${hmacSha256Hex(hmacKey, `ratelimit:${operation}:${target}`)}`;
}

/** A per-session key for authenticated operations. */
export function sessionBucketKey(sessionId: string, operation: string): string {
  return `session:${sessionId}:${operation}`;
}

/**
 * Count one attempt and throw the contract's 429 when over the limit.
 *
 * guards.ts audits the 429 (EDGE_RATE_LIMITED) and the 503
 * (EDGE_RATE_LIMITER_UNAVAILABLE). The 503 is FAIL-CLOSED by design: an
 * unreachable counter never becomes an unthrottled credential door.
 */
export async function enforceRateLimit(
  limiter: RateLimiter,
  bucketKey: string,
  limitPerMinute: number,
): Promise<void> {
  let allowed: boolean;
  try {
    allowed = (await limiter.check(bucketKey, limitPerMinute)).allowed;
  } catch (err) {
    if (err instanceof RateLimiterUnavailableError) {
      throw new HttpError(503, 'RATE_LIMITER_UNAVAILABLE', 'Temporarily unavailable. Try again shortly.', {
        cause: err,
      });
    }
    throw err;
  }
  if (!allowed) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Try again shortly.');
  }
}
