-- ══════════════════════════════════════════════════════════════════
-- 0015 — Service account store (client-credentials for machine callers)
--
-- The machine mirror of 0010's officer_accounts. Every kind:'system' route
-- in the platform (submit-application, eligibility gates, document
-- forensics, identity verify) is live and enforced — but until this slice
-- no system token was ever minted outside a selfcheck. iam-service gains a
-- client-credentials grant (ADR-016): a service client presents
-- { clientId, clientSecret }, iam verifies the secret against the scrypt
-- digest stored here, and mints a short-lived (15 min, owner D3) Ed25519
-- kind:'system' token. One row per service client: service_id (UUID = the
-- token `sub`), unique client_id, scrypt credential digest (NEVER a
-- plaintext secret), free-text description, active|disabled status.
--
-- Least-privilege, exactly like the officer store: readable/writable by
-- usrp_iam_service ALONE. Deliberately NO grant to usrp_system_service —
-- a compromised worker service must not be able to read the credential
-- digests that mint its own kind of token. FORCE'd RLS constrains the
-- owner; the single iam policy is USING(true) because a client_id lookup
-- has no narrower scope. Secret rotation, per-service scopes, and mTLS
-- binding are flagged follow-ons in ADR-016.
--
-- Run as usrp_admin AFTER db:migrate and 0001 (defines usrp_iam_service).
-- Fully re-runnable (IF NOT EXISTS + idempotent GRANT/POLICY).
-- ══════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS public_core.service_accounts (
  service_id   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),  -- = token `sub`
  client_id    varchar(128) UNIQUE NOT NULL,
  credential   text         NOT NULL,   -- scrypt$N$r$p$salt$hash — NEVER plaintext
  description  varchar(200),
  status       varchar(16)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at   timestamptz  NOT NULL DEFAULT now()
);

-- client_id already UNIQUE (implicit index); explicit named index to make the
-- lookup path obvious, mirroring idx_pc_officer_accounts_handle.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pc_service_accounts_client
  ON public_core.service_accounts (client_id);

-- iam-service is the SOLE reader/writer of the machine credential store.
GRANT SELECT, INSERT, UPDATE ON public_core.service_accounts TO usrp_iam_service;

-- FORCE RLS so even the table owner is constrained (mirrors officer_accounts).
ALTER TABLE public_core.service_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.service_accounts FORCE  ROW LEVEL SECURITY;

-- The only role with any policy → every other role sees nothing even if a
-- grant slips in later.
DROP POLICY IF EXISTS pc_sa_iam ON public_core.service_accounts;
CREATE POLICY pc_sa_iam ON public_core.service_accounts
  TO usrp_iam_service USING (true) WITH CHECK (true);

COMMIT;
