-- Enforced cross-agency isolation for USRP. Run as usrp_admin AFTER db:migrate.
-- Re-runnable. RLS is FORCEd so even table owners are constrained; the app must
-- connect as a NON-owner, NON-superuser login role (usrp_app) that is a member
-- of the agency roles below, or none of this bites.
BEGIN;

-- ── Roles (NOLOGIN group roles + one LOGIN app role) ──────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_rdf_officer')  THEN CREATE ROLE usrp_rdf_officer  NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_rnp_officer')  THEN CREATE ROLE usrp_rnp_officer  NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_rcs_officer')  THEN CREATE ROLE usrp_rcs_officer  NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_system_service') THEN CREATE ROLE usrp_system_service NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_app')          THEN CREATE ROLE usrp_app LOGIN PASSWORD 'app_pw'; END IF;
END$$;

-- usrp_app carries no privileges of its own; it only assumes agency roles via SET ROLE.
GRANT usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer, usrp_system_service TO usrp_app;

-- ── Schema usage ──────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public_core TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer, usrp_system_service;
GRANT USAGE ON SCHEMA rdf_ops TO usrp_rdf_officer, usrp_system_service;
GRANT USAGE ON SCHEMA rnp_ops TO usrp_rnp_officer, usrp_system_service;
GRANT USAGE ON SCHEMA rcs_ops TO usrp_rcs_officer, usrp_system_service;

-- Each officer role can read ONLY its own ops schema. System service reads all.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA rdf_ops TO usrp_rdf_officer;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA rnp_ops TO usrp_rnp_officer;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA rcs_ops TO usrp_rcs_officer;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA rdf_ops, rnp_ops, rcs_ops TO usrp_system_service;
GRANT SELECT, UPDATE ON public_core.applicant_identities
  TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer, usrp_system_service;

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