// ══════════════════════════════════════════════════════════════════
// edge-gateway — Shared fixed-window rate limiter (PostgreSQL, rls/0024)
//
// THE PRODUCTION implementation of the RateLimiter port. Counters live in
// public_core.edge_rate_limit_buckets, so N edge replicas enforce ONE rate:
// the login/OTP/NIDA caps and the citizen submission cap are properties of
// the DEPLOYMENT, not of whichever replica a load balancer picked.
//
// CONCURRENCY: the whole increment is ONE statement —
//   INSERT … ON CONFLICT (bucket_key_hash) DO UPDATE SET …
// with a CASE on window age — so parallel `check()` calls from any number
// of processes serialise on the row lock and every increment is counted.
// No read-modify-write, no lost updates, no advisory-lock ceremony.
//
// WHAT IS STORED: a KEYED hash of the bucket key (the session HMAC key,
// domain-separated with a "ratelimit:" prefix) — never the raw key. Bucket
// keys can carry a client IP or a National-Id-derived target hash; neither
// belongs in a database index.
//
// Runs as usrp_edge_gateway — the sole grantee on this table under FORCE'd
// RLS, the same posture as edge_sessions. A store fault throws
// RateLimiterUnavailableError, which the HTTP seam maps to a FAIL-CLOSED
// 503: an unreachable counter never becomes an unthrottled credential door.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { hmacSha256Hex } from '@usrp/shared-security';
import { RateLimiterUnavailableError, type RateLimitCheck, type RateLimiter } from '../ports/rate-limiter.js';

/** The least-privilege role that alone may touch the buckets table. */
const EDGE_DB_ROLE = 'usrp_edge_gateway';
/** Fixed windows are exactly one minute wide. */
const WINDOW_MS = 60_000;

/** Options: the SAME HMAC key the session store uses, domain-separated. */
export interface PgRateLimiterOptions {
  readonly hmacKey: string;
}

interface BucketRow {
  readonly count: number;
  readonly window_started_at: Date;
}

export class PgRateLimiter implements RateLimiter {
  readonly store = 'postgres' as const;
  readonly #hmacKey: string;

  constructor(options: PgRateLimiterOptions) {
    this.#hmacKey = options.hmacKey;
  }

  async check(bucketKey: string, limitPerMinute: number): Promise<RateLimitCheck> {
    // Keyed hash, domain-separated from every other use of the HMAC key, so
    // a bucket index can never be collided with a session handle hash.
    const hash = hmacSha256Hex(this.#hmacKey, `ratelimit:bucket:${bucketKey}`);
    const now = new Date();
    let row: BucketRow | undefined;
    try {
      const rows = await sql.begin(async (tx): Promise<BucketRow[]> => {
        await tx`SET LOCAL ROLE ${sql(EDGE_DB_ROLE)}`;
        // ONE atomic upsert: a new window starts at 1; a live window counts
        // this attempt; an expired window RESETS to 1. The row lock the ON
        // CONFLICT takes is what makes concurrent increments lossless.
        return tx<BucketRow[]>`
          INSERT INTO public_core.edge_rate_limit_buckets (bucket_key_hash, count, window_started_at)
          VALUES (${hash}, 1, ${now})
          ON CONFLICT (bucket_key_hash) DO UPDATE SET
            count = CASE
              WHEN public_core.edge_rate_limit_buckets.window_started_at <= ${new Date(now.getTime() - WINDOW_MS)}
                THEN 1
              ELSE public_core.edge_rate_limit_buckets.count + 1
            END,
            window_started_at = CASE
              WHEN public_core.edge_rate_limit_buckets.window_started_at <= ${new Date(now.getTime() - WINDOW_MS)}
                THEN ${now}
              ELSE public_core.edge_rate_limit_buckets.window_started_at
            END
          RETURNING count, window_started_at`;
      });
      row = rows[0];
    } catch (err) {
      throw new RateLimiterUnavailableError({ cause: err });
    }
    if (row === undefined) {
      // Unreachable in practice (the upsert always returns a row); treated
      // as a store fault rather than a silent allow.
      throw new RateLimiterUnavailableError();
    }

    if (row.count > limitPerMinute) {
      const elapsed = now.getTime() - row.window_started_at.getTime();
      return {
        allowed: false,
        remainingTokens: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1_000)),
      };
    }
    return { allowed: true, remainingTokens: Math.max(0, limitPerMinute - row.count), retryAfterSeconds: 0 };
  }

  async activeBuckets(now: Date): Promise<number> {
    try {
      const rows = await sql.begin(async (tx): Promise<{ readonly n: number }[]> => {
        await tx`SET LOCAL ROLE ${sql(EDGE_DB_ROLE)}`;
        return tx<{ readonly n: number }[]>`
          SELECT count(*)::int AS n FROM public_core.edge_rate_limit_buckets
          WHERE window_started_at > ${new Date(now.getTime() - WINDOW_MS)}`;
      });
      return rows[0]?.n ?? 0;
    } catch (err) {
      throw new RateLimiterUnavailableError({ cause: err });
    }
  }

  async sweep(now: Date): Promise<number> {
    try {
      const rows = await sql.begin(async (tx): Promise<{ readonly n: number }[]> => {
        await tx`SET LOCAL ROLE ${sql(EDGE_DB_ROLE)}`;
        return tx<{ readonly n: number }[]>`
          WITH deleted AS (
            DELETE FROM public_core.edge_rate_limit_buckets
            WHERE window_started_at <= ${new Date(now.getTime() - WINDOW_MS)}
            RETURNING 1
          ) SELECT count(*)::int AS n FROM deleted`;
      });
      return rows[0]?.n ?? 0;
    } catch (err) {
      throw new RateLimiterUnavailableError({ cause: err });
    }
  }
}
