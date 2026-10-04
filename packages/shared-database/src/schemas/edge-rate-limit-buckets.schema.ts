import {
  index,
  integer,
  pgSchema,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

const publicCore = pgSchema('public_core');

/**
 * The browser boundary's SHARED fixed-window rate-limit counters. One row per
 * live window, keyed by a keyed HASH of the bucket key (never the raw key —
 * bucket keys can carry IP addresses or National-Id-derived hashes). All
 * increments are a single atomic upsert, so counters are correct across any
 * number of edge replicas. Grants and FORCE'd RLS are applied by
 * rls/0024_edge_rate_limit_buckets.sql (usrp_edge_gateway only).
 */
export const edgeRateLimitBuckets = publicCore.table(
  'edge_rate_limit_buckets',
  {
    bucketKeyHash: varchar('bucket_key_hash', { length: 64 }).primaryKey(),
    count: integer('count').notNull(),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('idx_pc_edge_rate_limit_buckets_expired').on(t.windowStartedAt)],
);
