-- Enforced cross-agency isolation for USRP. Run as usrp_admin AFTER db:migrate.
-- Re-runnable. RLS is FORCEd so even table owners are constrained; application
-- traffic must use the NON-owner, NON-superuser usrp_app login. That login is
-- shared across backend processes and can SET ROLE to its granted service roles,
-- so this is a trusted-backend boundary, not per-process DB identity isolation.
-- The one-purpose usrp_iam_provisioner login is separate and never granted to
-- usrp_app; its password/certificate is provisioned out of band.
BEGIN;

-- ── Roles (NOLOGIN group roles + shared app + dedicated operator login) ─
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_rdf_officer')  THEN CREATE ROLE usrp_rdf_officer  NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_rnp_officer')  THEN CREATE ROLE usrp_rnp_officer  NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_rcs_officer')  THEN CREATE ROLE usrp_rcs_officer  NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_system_service') THEN CREATE ROLE usrp_system_service NOLOGIN; END IF;
  -- Least-privilege role for the IAM/credential surface. Deliberately NOT
  -- usrp_system_service: only this role receives table grants in rls/0010 and
  -- 0015. Since usrp_app is shared and is a member, any trusted backend with
  -- that login can SET ROLE to it; this does not independently isolate the
  -- IAM process from another backend using the same credential.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_iam_service') THEN CREATE ROLE usrp_iam_service NOLOGIN; END IF;
  -- Separate, one-purpose database identity for the human-operated first-admin
  -- bootstrap. It has no password until an operator provisions one out of band;
  -- unlike usrp_iam_service it is deliberately NOT a member of usrp_app.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_iam_provisioner') THEN CREATE ROLE usrp_iam_provisioner LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_app')          THEN CREATE ROLE usrp_app LOGIN PASSWORD 'app_pw'; END IF;
END$$;

-- The dedicated first-admin login must remain a one-purpose, standalone
-- identity even when this script is re-run against a database where the role
-- predates BUILD-001. No inherited privileges or cluster/database powers.
ALTER ROLE usrp_iam_provisioner
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- usrp_app carries no privileges of its own; it assumes service/agency roles
-- via SET ROLE. The dedicated provisioner is intentionally not granted to it.
GRANT usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer, usrp_system_service, usrp_iam_service TO usrp_app;

-- ── Schema usage ──────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public_core TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer, usrp_system_service, usrp_iam_service, usrp_iam_provisioner;
GRANT USAGE ON SCHEMA rdf_ops TO usrp_rdf_officer, usrp_system_service;
GRANT USAGE ON SCHEMA rnp_ops TO usrp_rnp_officer, usrp_system_service;
GRANT USAGE ON SCHEMA rcs_ops TO usrp_rcs_officer, usrp_system_service;

-- Each officer role can read ONLY its own ops schema. System service reads all.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA rdf_ops TO usrp_rdf_officer;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA rnp_ops TO usrp_rnp_officer;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA rcs_ops TO usrp_rcs_officer;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA rdf_ops, rnp_ops, rcs_ops TO usrp_system_service;
-- Officers may read/update the shared identity (subject to RLS below) but
-- never CREATE one — identities originate only from the system service after
-- NIDA verification (identity-service is the system-of-record).
GRANT SELECT, UPDATE ON public_core.applicant_identities
  TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;
-- The system service creates identities (INSERT) and maintains them (UPDATE:
-- verification metadata, soft-delete erasure). Hard DELETE is intentionally
-- withheld — erasure under Law N° 058/2021 is the soft-delete path.
GRANT SELECT, INSERT, UPDATE ON public_core.applicant_identities
  TO usrp_system_service;

-- ── RLS on the shared identity table (the real leak surface) ──────
ALTER TABLE public_core.applicant_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.applicant_identities FORCE  ROW LEVEL SECURITY;

-- System workers see everything (they run vetting across agencies).
DROP POLICY IF EXISTS pc_ai_system ON public_core.applicant_identities;
CREATE POLICY pc_ai_system ON public_core.applicant_identities
  TO usrp_system_service USING (true) WITH CHECK (true);

-- An officer can resolve an identity ONLY if that identity has an application
-- in their own agency's ops schema. No application => invisible.
DROP POLICY IF EXISTS pc_ai_rdf ON public_core.applicant_identities;
CREATE POLICY pc_ai_rdf ON public_core.applicant_identities
  TO usrp_rdf_officer
  USING (EXISTS (SELECT 1 FROM rdf_ops.applications a WHERE a.applicant_id = applicant_identities.id));

DROP POLICY IF EXISTS pc_ai_rnp ON public_core.applicant_identities;
CREATE POLICY pc_ai_rnp ON public_core.applicant_identities
  TO usrp_rnp_officer
  USING (EXISTS (SELECT 1 FROM rnp_ops.applications a WHERE a.applicant_id = applicant_identities.id));

DROP POLICY IF EXISTS pc_ai_rcs ON public_core.applicant_identities;
CREATE POLICY pc_ai_rcs ON public_core.applicant_identities
  TO usrp_rcs_officer
  USING (EXISTS (SELECT 1 FROM rcs_ops.applications a WHERE a.applicant_id = applicant_identities.id));

COMMIT;