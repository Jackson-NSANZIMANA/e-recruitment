-- ══════════════════════════════════════════════════════════════════
-- 0010 — Officer account store (the token issuer's credential surface)
--
-- The FIRST human-account table in USRP. Until now signAuthToken existed only
-- inside selfchecks — nobody could log in outside a test. iam-service mints
-- Ed25519 bearer tokens (the ones the Slice-4 officer endpoints already accept)
-- after verifying an officer's handle + password against this table. One row per
-- officer: officer_id (UUID = the token `sub`, so it lands cleanly in the
-- UUID medical_reviewed_by_id / final_decision_by_id stamp columns), login
-- handle, a scrypt password digest (NEVER a plaintext — see shared-security
-- hashPassword), owning agency, roles, and an active|disabled status.
--
-- Least-privilege by role grant: usrp_iam_service may SELECT officer
-- credentials for login, but cannot insert, update, promote, or delete accounts.
-- Officer creation/promotion uses the separately authenticated first-admin
-- provisioning boundary or a privileged deployment/operator workflow. rls/0001
-- grants usrp_iam_service membership to the shared usrp_app login, so any trusted
-- backend using that login can SET ROLE and read this credential store. This is
-- NOT database-enforced process isolation. Login is a cross-agency lookup, so
-- the iam RLS policy is USING(true); FORCE'd RLS still constrains ordinary roles.
-- Real IdP/SSO, MFA, and lockout remain deferred.
--
-- Run as usrp_admin AFTER db:migrate and 0001 (which defines usrp_iam_service).
-- Fully re-runnable (IF NOT EXISTS + idempotent GRANT/POLICY).
-- ══════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS public_core.officer_accounts (
  officer_id    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),  -- = token `sub`
  login_handle  varchar(128) UNIQUE NOT NULL,
  credential    text         NOT NULL,   -- scrypt$N$r$p$salt$hash — NEVER plaintext/PII
  agency        public_core.agency NOT NULL,
  roles         text[]       NOT NULL DEFAULT '{}',
  status        varchar(16)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz  NOT NULL DEFAULT now()
);

-- login_handle already UNIQUE (implicit index); add an explicit named index to
-- match the drizzle mirror and make the lookup path obvious.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pc_officer_accounts_handle
  ON public_core.officer_accounts (login_handle);

-- IAM authenticates against this table but is not an account-provisioning
-- authority. Clear historical table/column ACLs before granting read-only access.
REVOKE ALL PRIVILEGES ON TABLE public_core.officer_accounts FROM usrp_iam_service;
REVOKE INSERT (officer_id, login_handle, credential, agency, roles, status, created_at),
       UPDATE (officer_id, login_handle, credential, agency, roles, status, created_at)
  ON public_core.officer_accounts FROM usrp_iam_service;
GRANT SELECT ON public_core.officer_accounts TO usrp_iam_service;

-- FORCE RLS so even the table owner is constrained (mirrors applicant_identities
-- and field_devices).
ALTER TABLE public_core.officer_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.officer_accounts FORCE  ROW LEVEL SECURITY;

-- iam-service authenticates across all agencies (login resolves a handle before
-- the agency is known), so its policy is unconditional. It is the only role
-- with any policy → every other role sees nothing even if a grant slipped in.
DROP POLICY IF EXISTS pc_oa_iam ON public_core.officer_accounts;
CREATE POLICY pc_oa_iam ON public_core.officer_accounts
  FOR SELECT TO usrp_iam_service USING (true);

COMMIT;
