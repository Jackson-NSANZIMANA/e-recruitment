-- ══════════════════════════════════════════════════════════════════
-- 0019 — Edge session store (ADR-021, the edge tier)
--
-- The browser holds an opaque HANDLE; the real upstream credential (an
-- officer Ed25519 JWT or a citizen opaque token) lives HERE, server-side.
-- This table is therefore the highest-value row store in the platform, and
-- every column below is shaped by that:
--
--   handle_hash             A KEYED hash (HMAC-SHA256 under
--                           EDGE_SESSION_HMAC_KEY), never the handle. A
--                           leaked dump is not a set of replayable sessions,
--                           because the key lives in the process/HSM and not
--                           in this table. Same posture as national_id_hash.
--   credential_ciphertext   AES-256-GCM envelope. Reading this table does not
--                           yield a usable bearer token for any upstream.
--   agency                  Officer only, and the CHECK below makes
--                           "ApplicantSession carries no agency" a DATABASE
--                           constraint rather than a convention three
--                           TypeScript files agree to honour. A citizen is
--                           cross-agency by nature (ADR-014's accept lock
--                           spans all three); an agency on a citizen row
--                           would be the first step back to per-agency BFFs.
--   idle_ / absolute_       TWO expiries, not one. The idle window slides on
--                           activity; the absolute ceiling never moves, so a
--                           stolen handle cannot be kept alive forever by the
--                           thief's own traffic. A sliding TTL alone is an
--                           immortal session.
--   revoked_at              Explicit revocation, distinct from expiry, because
--                           the UI must say "this session was ended" rather
--                           than "you were away too long". It is also the ONLY
--                           revocation point an officer has: the upstream JWT
--                           is non-revocable until expiry by design (ADR-016).
--
-- DEDICATED LEAST-PRIVILEGE ROLE. usrp_edge_session_writer is NOLOGIN and
-- holds rights on this table and nothing else — the edge process never needs
-- usrp_system_service, which can read every applicant identity in the country.
-- Same shape as usrp_audit_writer (0002).
--
-- Run as usrp_admin AFTER db:migrate and 0001. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usrp_edge_session_writer') THEN
    CREATE ROLE usrp_edge_session_writer NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public_core TO usrp_edge_session_writer;

CREATE TABLE IF NOT EXISTS public_core.edge_sessions (
  handle_hash           varchar(64)  PRIMARY KEY,
  kind                  text         NOT NULL,
  agency                public_core.agency,
  roles                 jsonb        NOT NULL DEFAULT '[]'::jsonb,
  subject_id            text,
  credential_ciphertext text         NOT NULL,
  credential_expires_at timestamptz  NOT NULL,
  csrf_token            varchar(128) NOT NULL,
  idle_expires_at       timestamptz  NOT NULL,
  absolute_expires_at   timestamptz  NOT NULL,
  revoked_at            timestamptz,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  last_seen_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT edge_sessions_kind_chk CHECK (kind IN ('officer', 'applicant')),
  -- An officer session HAS an agency; an applicant session CANNOT have one.
  CONSTRAINT edge_sessions_agency_chk CHECK (
    (kind = 'officer'   AND agency IS NOT NULL AND subject_id IS NOT NULL) OR
    (kind = 'applicant' AND agency IS NULL     AND subject_id IS NULL)
  ),
  -- An absolute ceiling below the sliding window would expire active sessions.
  CONSTRAINT edge_sessions_ttl_chk CHECK (absolute_expires_at >= idle_expires_at)
);

-- The retention sweep and the readiness probe both scan by expiry.
CREATE INDEX IF NOT EXISTS idx_pc_edge_sessions_absolute
  ON public_core.edge_sessions (absolute_expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public_core.edge_sessions TO usrp_edge_session_writer;

-- usrp_app assumes the role per request via SET LOCAL ROLE (rls/0001 pattern).
GRANT usrp_edge_session_writer TO usrp_app;

ALTER TABLE public_core.edge_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.edge_sessions FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pc_edge_sessions_writer ON public_core.edge_sessions;
CREATE POLICY pc_edge_sessions_writer ON public_core.edge_sessions
  TO usrp_edge_session_writer USING (true) WITH CHECK (true);

-- No policy for usrp_system_service or the officer roles: with RLS FORCE'd and
-- no policy naming them, this table is invisible to every other principal in
-- the platform, table owner included.

COMMIT;
