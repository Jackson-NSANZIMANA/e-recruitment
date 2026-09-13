-- ═════════════════════════════════════════════════════════════
-- 0019 — Edge session store (the browser boundary's own state)
--
-- The table that makes ADR-021's edge tier real. The browser holds an opaque
-- handle; THIS row holds the upstream credential it maps to.
--
-- WHY IT IS IN POSTGRES AND NOT IN A PROCESS. An in-memory map would mean every
-- deploy logs out every officer mid-shift, a second replica cannot serve a
-- session the first one issued, and "revoke" becomes a promise one process makes
-- about itself. Per ADR-016 an officer's Ed25519 JWT is NOT revocable until it
-- expires, so this table IS the only revocation mechanism the platform's most
-- privileged human sessions have. It has to survive a restart.
--
-- THREE COLUMNS ARE PROTECTED, NOT MERELY STORED:
--
--   handle_hash              a KEYED hash (EDGE_SESSION_HMAC_KEY), never the
--                            handle. A leaked dump is then not a set of
--                            replayable sessions — the key lives in the
--                            process/HSM, not the row. Same posture as
--                            national_id_hash.
--   csrf_token_hash          same. The CSRF token is not a credential, but a
--                            stored plaintext would let a dump forge the half
--                            double-submit relies on being unforgeable.
--   upstream_credential      AES-256-GCM sealed application-side under a key
--                            DERIVED from EDGE_SESSION_HMAC_KEY with domain
--                            separation. The database never sees a usable token.
--
-- LEAST PRIVILEGE, LIKE THE OTHER CREDENTIAL STORES. officer_accounts (0010) is
-- readable by usrp_iam_service ALONE and service_accounts (0015) likewise; this
-- follows the pattern with a new usrp_edge_gateway role. Deliberately NOT
-- granted to usrp_system_service: nine services run as that role, and any one of
-- them being compromised must not yield live officer sessions. No officer role
-- either — officers never read the session store, not even their own row.
--
-- TWO TTLs, TWO COLUMNS. idle_expires_at slides on activity; absolute_expires_at
-- is a hard ceiling no amount of activity extends. A sliding TTL alone is an
-- immortal session: a thief with a stolen handle keeps it alive with their own
-- traffic forever.
--
-- Run as usrp_admin AFTER db:migrate and 0001. Fully re-runnable.
-- ═════════════════════════════════════════════════════════════
BEGIN;

-- The edge's own NOLOGIN group role. usrp_app becomes a member so the service's
-- `SET LOCAL ROLE` succeeds; there is no separate login for it, exactly like
-- every other role in 0001.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usrp_edge_gateway') THEN
    CREATE ROLE usrp_edge_gateway NOLOGIN;
  END IF;
END
$$;

GRANT usrp_edge_gateway TO usrp_app;
GRANT USAGE ON SCHEMA public_core TO usrp_edge_gateway;

CREATE TABLE IF NOT EXISTS public_core.edge_sessions (
  session_id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- HMAC-SHA256 hex of the opaque handle. UNIQUE: one live handle per session.
  handle_hash               varchar(64)  UNIQUE NOT NULL,
  -- The pre-rotation pair, valid only until previous_valid_until. Without this
  -- grace window a refresh would 401 the SPA's own in-flight requests, and the
  -- failure would be indistinguishable from a broken session store.
  previous_handle_hash      varchar(64),
  previous_csrf_token_hash  varchar(64),
  previous_valid_until      timestamptz,

  csrf_token_hash           varchar(64)  NOT NULL,

  kind                      varchar(16)  NOT NULL CHECK (kind IN ('officer', 'applicant')),
  -- The officer UUID (= the token `sub`). NULL for an applicant: the edge never
  -- learns who a citizen is — it holds only their opaque upstream token.
  subject_id                uuid,
  -- NULL for an applicant, deliberately. A citizen is cross-agency by
  -- construction (ADR-014's accept lock spans all three, and the citizen read
  -- unions three ops schemas), so an agency here would be a modelling error that
  -- silently narrows their own view of their own applications.
  agency                    public_core.agency,
  roles                     text[]       NOT NULL DEFAULT '{}',

  -- AES-256-GCM envelope. Blanked to '' on revoke, so a revoked row is not a
  -- copy of a live, non-revocable officer JWT sitting out the retention window.
  upstream_credential       text         NOT NULL,
  -- When the CREDENTIAL itself dies (officer JWT `exp`), which can precede the
  -- session's own deadlines.
  upstream_expires_at       timestamptz,

  issued_at                 timestamptz  NOT NULL DEFAULT now(),
  idle_expires_at           timestamptz  NOT NULL,
  absolute_expires_at       timestamptz  NOT NULL,
  last_seen_at              timestamptz  NOT NULL DEFAULT now(),
  rotated_at                timestamptz,
  revoked_at                timestamptz,
  revoked_reason            varchar(32),

  -- An officer session without an agency is not a degraded session, it is an
  -- unauthorized one: every officer read derives agency from it. The engine
  -- refuses the half-formed row rather than trusting application logic never to
  -- write one.
  CONSTRAINT edge_sessions_officer_shape CHECK (
    (kind = 'officer'   AND agency IS NOT NULL AND subject_id IS NOT NULL)
    OR
    (kind = 'applicant' AND agency IS NULL)
  ),
  -- An absolute ceiling below the sliding window is a silent contradiction that
  -- would expire active sessions for no stated reason.
  CONSTRAINT edge_sessions_ttl_order CHECK (absolute_expires_at >= idle_expires_at)
);

-- The rotation grace lookup: resolve() matches either the current handle or a
-- still-live previous one, so this is a hot path on every authenticated request.
CREATE INDEX IF NOT EXISTS idx_pc_edge_sessions_prev_handle
  ON public_core.edge_sessions (previous_handle_hash)
  WHERE previous_handle_hash IS NOT NULL;

-- The sweeper deletes by absolute deadline; without this it is a full scan every
-- fifteen minutes for the life of the deployment.
CREATE INDEX IF NOT EXISTS idx_pc_edge_sessions_absolute
  ON public_core.edge_sessions (absolute_expires_at);

-- The edge is the SOLE reader/writer. No system_service grant, no officer grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON public_core.edge_sessions TO usrp_edge_gateway;

-- FORCE so even the table owner is constrained, mirroring applicant_identities,
-- field_devices and officer_accounts.
ALTER TABLE public_core.edge_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.edge_sessions FORCE  ROW LEVEL SECURITY;

-- One unconditional policy for one role. The edge resolves handles across both
-- session kinds and all three agencies before any of them is known, so the
-- policy cannot be predicated on agency. It is the ONLY role with any policy →
-- every other role sees nothing even if a grant were ever added by mistake.
DROP POLICY IF EXISTS pc_edge_sessions_edge ON public_core.edge_sessions;
CREATE POLICY pc_edge_sessions_edge ON public_core.edge_sessions
  TO usrp_edge_gateway USING (true) WITH CHECK (true);

COMMIT;
