-- ══════════════════════════════════════════════════════════════════
-- USRP — Database Role Hierarchy (canonical)
--
-- SINGLE SOURCE OF TRUTH for the role MODEL is packages/shared-database/
-- src/rls/0001_roles_grants_rls.sql (+ 0002 for the audit writer), applied
-- by scripts/bootstrap-db.sh. This init-script only pre-creates the SAME
-- roles in the SAME shape so a fresh docker-entrypoint database already has
-- them; every GRANT / RLS POLICY is owned by the rls/* migrations, not here.
--
-- The model (see rls/0001):
--   • usrp_rdf_officer / usrp_rnp_officer / usrp_rcs_officer — NOLOGIN group
--     roles, one per agency; each may read ONLY its own ops schema.
--   • usrp_system_service — NOLOGIN group role for cross-agency workers.
--   • usrp_audit_writer — NOLOGIN append-only audit role (created in rls/0002).
--   • usrp_app — the shared application LOGIN. It carries no table privileges
--     of its own and assumes service/agency roles per transaction via SET ROLE.
--     This is a trusted-backend boundary: every process sharing its credential
--     can assume every role granted to usrp_app.
--   • usrp_iam_provisioner — one-purpose LOGIN for first-admin provisioning.
--     It is not a member of usrp_app or usrp_iam_service; its password or
--     certificate is provisioned out of band. It receives only the narrow
--     function EXECUTE grant in rls/0027.
--
-- NOTE: officers and function-owner roles are NOLOGIN (not direct logins).
-- There is deliberately NO usrp_readonly / usrp_superadmin role — add a
-- dedicated SELECT-only role only when a concrete oversight requirement exists.
-- ══════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_rdf_officer')    THEN CREATE ROLE usrp_rdf_officer    NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_rnp_officer')    THEN CREATE ROLE usrp_rnp_officer    NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_rcs_officer')    THEN CREATE ROLE usrp_rcs_officer    NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_system_service') THEN CREATE ROLE usrp_system_service NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_iam_service') THEN CREATE ROLE usrp_iam_service NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_iam_provisioner') THEN CREATE ROLE usrp_iam_provisioner LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_app')            THEN CREATE ROLE usrp_app LOGIN PASSWORD 'app_pw'; END IF;
END$$;

-- Reassert the dedicated provisioner's standalone, non-privileged login
-- attributes on every bootstrap run; existing roles are not reset by CREATE IF NOT EXISTS.
ALTER ROLE usrp_iam_provisioner
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- usrp_app assumes agency/system/IAM service roles via SET ROLE; it holds no
-- table grants itself. The standalone provisioner must never be inherited.
GRANT usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer, usrp_system_service, usrp_iam_service TO usrp_app;

SELECT rolname, rolcanlogin
FROM pg_roles
WHERE rolname LIKE 'usrp_%'
ORDER BY rolname;
