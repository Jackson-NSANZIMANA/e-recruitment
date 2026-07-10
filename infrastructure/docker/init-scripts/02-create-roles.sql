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
--   • usrp_app — the ONE login role. It carries no privileges of its own; it
--     assumes a group role per-transaction via SET LOCAL ROLE.
--
-- NOTE: officers are NOLOGIN here (not direct logins) and there is deliberately
-- NO usrp_readonly / usrp_superadmin role — see the engagement decision on
-- least-privilege (a superadmin DB role is added only when a concrete oversight
-- requirement exists, as a dedicated SELECT-only role in a new rls migration).
-- ══════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_rdf_officer')    THEN CREATE ROLE usrp_rdf_officer    NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_rnp_officer')    THEN CREATE ROLE usrp_rnp_officer    NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_rcs_officer')    THEN CREATE ROLE usrp_rcs_officer    NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_system_service') THEN CREATE ROLE usrp_system_service NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_app')            THEN CREATE ROLE usrp_app LOGIN PASSWORD 'app_pw'; END IF;
END$$;

-- usrp_app assumes agency/system roles via SET ROLE; it holds nothing itself.
GRANT usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer, usrp_system_service TO usrp_app;

SELECT rolname, rolcanlogin
FROM pg_roles
WHERE rolname LIKE 'usrp_%'
ORDER BY rolname;
