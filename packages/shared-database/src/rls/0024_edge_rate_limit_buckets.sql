-- ══════════════════════════════════════════════════════════════════
-- 0024 — the shared rate-limit store (ADR-021 / ADR-027 follow-up)
--
-- THE DEFECT: the edge's limiter was per-process (rate-limiter.memory.ts),
-- so N replicas permitted N times the configured rate on exactly the
-- operations where the limit is a CORRECTNESS control — login, OTP, NIDA
-- checks and now citizen submission. The port has been async since the edge
-- homogenisation precisely so a shared store could sit behind it; this is
-- that store.
--
-- Table: public_core.edge_rate_limit_buckets, one row per live fixed window.
-- The whole increment is ONE atomic upsert (INSERT ... ON CONFLICT DO UPDATE
-- with a CASE on window age), so concurrent increments from any number of
-- replicas are serialised by the row lock and none is lost.
--
-- WHAT IS STORED AND WHAT IS NOT:
--   • bucket_key_hash  a KEYED hash (EDGE_SESSION_HMAC_KEY, domain-separated
--                      by a "ratelimit:" prefix), never the raw key. Keys
--                      carry IP addresses and derived National-Id hashes;
--                      a bucket index is not a place for either.
--   • no subject data. A bucket row cannot be joined back to a citizen, an
--                      officer or a session by anything but the keyed hash.
--
-- usrp_edge_gateway only, under FORCE'd RLS — the same sole-grantee posture
-- as edge_sessions (rls/0019), because both tables are the browser
-- boundary's own state. No officer role and no system role can read,
-- amend or delete a rate-limit window.
-- ══════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public_core.edge_rate_limit_buckets (
  bucket_key_hash  varchar(64)  PRIMARY KEY,
  count            integer      NOT NULL,
  window_started_at timestamptz NOT NULL
);

-- The sweeper's working set: windows that have expired. Keeps the DELETE
-- proportional to the cleanup, not to history.
CREATE INDEX IF NOT EXISTS idx_pc_edge_rate_limit_buckets_expired
  ON public_core.edge_rate_limit_buckets (window_started_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public_core.edge_rate_limit_buckets
  TO usrp_edge_gateway;

ALTER TABLE public_core.edge_rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.edge_rate_limit_buckets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pc_edge_rate_limit_buckets ON public_core.edge_rate_limit_buckets;
CREATE POLICY pc_edge_rate_limit_buckets ON public_core.edge_rate_limit_buckets
  TO usrp_edge_gateway USING (true) WITH CHECK (true);

COMMIT;
