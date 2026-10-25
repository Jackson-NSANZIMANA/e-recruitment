// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — real-world behaviour (ADR-047 §3.3)
//
// Per authority: a log-normal latency (p50/p95) and a per-client token bucket
// (exceeding it is 429 + Retry-After, never a negative verdict). Per persona,
// and per request in sandbox/development (`x-usrp-sandbox-behaviour`), one of
// BEHAVIOURS: slow, rate-limited, maintenance, timeout, truncated, status-false.
// ══════════════════════════════════════════════════════════════════

import { BEHAVIOURS, type Authority, type BehaviourName } from './population/model.js';

export interface AuthorityProfile {
  readonly p50Ms: number;
  readonly p95Ms: number;
  /** Token bucket: burst capacity and steady refill per second, per client. */
  readonly bucketCapacity: number;
  readonly refillPerSecond: number;
}

export const DEFAULT_PROFILES: Readonly<Record<Authority, AuthorityProfile>> = {
  nida: { p50Ms: 120, p95Ms: 650, bucketCapacity: 30, refillPerSecond: 10 },
  nesa: { p50Ms: 180, p95Ms: 900, bucketCapacity: 30, refillPerSecond: 10 },
  'irembo-certificates': { p50Ms: 250, p95Ms: 1200, bucketCapacity: 20, refillPerSecond: 5 },
  sms: { p50Ms: 90, p95Ms: 400, bucketCapacity: 50, refillPerSecond: 20 },
};

export const BEHAVIOUR_HEADER = 'x-usrp-sandbox-behaviour';
export const RETRY_AFTER_SECONDS = { 'rate-limited': 30, maintenance: 300 } as const;

/** A log-normal sample with the given median and 95th percentile. */
export function sampleLatencyMs(profile: AuthorityProfile, random: () => number, scale = 1): number {
  if (scale <= 0) return 0;
  const sigma = Math.log(Math.max(profile.p95Ms, profile.p50Ms + 1) / profile.p50Ms) / 1.6449;
  const u1 = Math.max(random(), 1e-12);
  const u2 = random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.round(profile.p50Ms * Math.exp(sigma * z) * scale);
}

export function isBehaviour(value: string): value is BehaviourName {
  return (BEHAVIOURS as readonly string[]).includes(value);
}

/**
 * Parse `x-usrp-sandbox-behaviour`: either one behaviour for whichever
 * authority answers ("maintenance"), or per authority ("nida=slow,nesa=timeout").
 * Unknown entries are ignored, never echoed.
 */
export function requestedBehaviour(header: string | null, authority: Authority): BehaviourName | null {
  if (header === null) return null;
  for (const part of header.split(',')) {
    const [left, right] = part.split('=').map((s) => s.trim().toLowerCase());
    if (left === undefined) continue;
    if (right === undefined && isBehaviour(left)) return left;
    if (right !== undefined && left === authority && isBehaviour(right)) return right;
  }
  return null;
}

/** Per-client token buckets, keyed by authority + client. */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly profiles: Readonly<Record<Authority, AuthorityProfile>>, private readonly clock: () => number = Date.now) {}

  /** Take one token; false when the client is over budget. */
  take(authority: Authority, client: string): boolean {
    const profile = this.profiles[authority];
    const key = `${authority}\u0000${client}`;
    const now = this.clock();
    const bucket = this.buckets.get(key) ?? { tokens: profile.bucketCapacity, at: now };
    bucket.tokens = Math.min(profile.bucketCapacity, bucket.tokens + ((now - bucket.at) / 1000) * profile.refillPerSecond);
    bucket.at = now;
    const ok = bucket.tokens >= 1;
    if (ok) bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return ok;
  }
}
