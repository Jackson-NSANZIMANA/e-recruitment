// ══════════════════════════════════════════════════════════════════
// edge-gateway — Rate limiting for the credential and identity doors
//
// On officer login and applicant OTP this is a CORRECTNESS control, not
// hardening. `202 Accepted` on OTP request is deliberately uninformative, but
// an uninformative body is still an enumeration oracle if you can submit
// candidate National IDs at machine speed and measure volume or timing. The
// limiter is what makes the silence mean something.
//
// TWO BUCKETS PER REQUEST, both must pass:
//
//   target  the thing being probed — a login handle, or a keyed hash of the
//           submitted National ID. This is the bucket that actually stops
//           enumeration, because enumeration means many attempts against MANY
//           targets from possibly many sources; a per-target cap makes each
//           target expensive regardless of where the traffic comes from.
//   client  the caller. Derived from `x-forwarded-for` using a CONFIGURED hop
//           count, and with EDGE_TRUSTED_PROXY_HOPS=0 every caller shares ONE
//           bucket. That default is the strictest behaviour available, not the
//           weakest: a spoofable per-client key would be worse than a global
//           cap, so the fail-closed direction is to stop distinguishing.
//
// The target key is HASHED before it becomes a map key. A National ID must not
// sit in process memory as a plaintext index, and a heap dump is a real
// disclosure channel for a national identifier.
//
// HONEST LIMITATION, recorded rather than hidden: this counter is per-process,
// so N replicas permit N times the configured rate. The bound is still a bound
// and it is orders of magnitude below what an enumeration run needs. A shared
// counter is a named residual in ADR-024; the peer address is also unavailable
// through shared-http's RequestContext today, which is why the client bucket
// leans on the ingress.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type RequestContext } from '@usrp/shared-http';
import { hmacSha256Hex } from '@usrp/shared-security';

const WINDOW_MS = 60_000;
/** Above this many live buckets, the sweeper runs on write instead of on timer. */
const SWEEP_THRESHOLD = 10_000;

interface Bucket {
  count: number;
  windowStartedAt: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export class FixedWindowRateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  check(key: string, limitPerMinute: number): RateLimitDecision {
    const now = this.#now();
    if (this.#buckets.size > SWEEP_THRESHOLD) this.#sweep(now);

    const existing = this.#buckets.get(key);
    if (existing === undefined || now - existing.windowStartedAt >= WINDOW_MS) {
      this.#buckets.set(key, { count: 1, windowStartedAt: now });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    existing.count += 1;
    if (existing.count > limitPerMinute) {
      const elapsed = now - existing.windowStartedAt;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1_000)),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Live bucket count — surfaced in the readiness/observability line. */
  size(): number {
    return this.#buckets.size;
  }

  #sweep(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.windowStartedAt >= WINDOW_MS) this.#buckets.delete(key);
    }
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The client bucket key.
 *
 * `x-forwarded-for` is a list the CLIENT can prepend to; only the last
 * `trustedProxyHops` entries were written by infrastructure we control. We take
 * the entry that our own outermost proxy appended and ignore everything the
 * caller may have invented. With hops=0 nothing is trusted and every caller
 * shares one bucket.
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

/** A hashed target key. The plaintext target never becomes a map index. */
export function targetBucketKey(hmacKey: string, operation: string, target: string): string {
  return `target:${operation}:${hmacSha256Hex(hmacKey, `ratelimit:${operation}:${target}`)}`;
}

/** Throw the contract's 429. `retry-after` is advisory and carries no subject detail. */
export function assertWithinLimit(decision: RateLimitDecision): void {
  if (decision.allowed) return;
  throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Try again shortly.');
}
