-- ══════════════════════════════════════════════════════════════════
-- USRP — Database Role Hierarchy
-- Principle of least privilege throughout
-- ══════════════════════════════════════════════════════════════════

-- ── Service Roles (used by backend microservices) ─────────────────
DO $$ BEGIN
  CREATE ROLE usrp_system_service LOGIN PASSWORD 'CHANGE_IN_PRODUCTION';
  EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'Role usrp_system_service already exists';
END $$;

-- ── Agency Officer Roles (used by BFF services) ───────────────────
DO $$ BEGIN
  CREATE ROLE usrp_rdf_officer LOGIN PASSWORD 'CHANGE_IN_PRODUCTION';
  EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'Role usrp_rdf_officer already exists';
END $$;

DO $$ BEGIN
  CREATE ROLE usrp_rnp_officer LOGIN PASSWORD 'CHANGE_IN_PRODUCTION';
  EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'Role usrp_rnp_officer already exists';
END $$;

DO $$ BEGIN
  CREATE ROLE usrp_rcs_officer LOGIN PASSWORD 'CHANGE_IN_PRODUCTION';
  EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'Role usrp_rcs_officer already exists';
END $$;

-- ── Read-only Role (analytics, monitoring) ────────────────────────
DO $$ BEGIN
  CREATE ROLE usrp_readonly LOGIN PASSWORD 'CHANGE_IN_PRODUCTION';
  EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'Role usrp_readonly already exists';
END $$;

-- ── Superadmin (MoD oversight only) ──────────────────────────────
DO $$ BEGIN
  CREATE ROLE usrp_superadmin LOGIN PASSWORD 'CHANGE_IN_PRODUCTION';
  EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'Role usrp_superadmin already exists';
END $$;

-- ── Schema Grants: System Service (full access for vetting workers) 
GRANT USAGE ON SCHEMA public_core TO usrp_system_service;
GRANT USAGE ON SCHEMA rdf_ops TO usrp_system_service;
GRANT USAGE ON SCHEMA rnp_ops TO usrp_system_service;
GRANT USAGE ON SCHEMA rcs_ops TO usrp_system_service;
GRANT USAGE ON SCHEMA audit_log TO usrp_system_service;

-- ── Schema Grants: Agency Officers (ISOLATED — cross-access denied)
GRANT USAGE ON SCHEMA public_core TO usrp_rdf_officer;
GRANT USAGE ON SCHEMA rdf_ops TO usrp_rdf_officer;
-- CRITICAL: RDF cannot see RNP or RCS schemas
REVOKE ALL ON SCHEMA rnp_ops FROM usrp_rdf_officer;
REVOKE ALL ON SCHEMA rcs_ops FROM usrp_rdf_officer;

GRANT USAGE ON SCHEMA public_core TO usrp_rnp_officer;
GRANT USAGE ON SCHEMA rnp_ops TO usrp_rnp_officer;
REVOKE ALL ON SCHEMA rdf_ops FROM usrp_rnp_officer;
REVOKE ALL ON SCHEMA rcs_ops FROM usrp_rnp_officer;

GRANT USAGE ON SCHEMA public_core TO usrp_rcs_officer;
GRANT USAGE ON SCHEMA rcs_ops TO usrp_rcs_officer;
REVOKE ALL ON SCHEMA rdf_ops FROM usrp_rcs_officer;
REVOKE ALL ON SCHEMA rnp_ops FROM usrp_rcs_officer;

-- ── Schema Grants: Superadmin (read all, no delete) ───────────────
GRANT USAGE ON SCHEMA public_core TO usrp_superadmin;
GRANT USAGE ON SCHEMA rdf_ops TO usrp_superadmin;
GRANT USAGE ON SCHEMA rnp_ops TO usrp_superadmin;
GRANT USAGE ON SCHEMA rcs_ops TO usrp_superadmin;
GRANT USAGE ON SCHEMA audit_log TO usrp_superadmin;

-- ── Audit log: append-only enforcement ───────────────────────────
-- Even superadmin cannot delete audit records
REVOKE DELETE ON ALL TABLES IN SCHEMA audit_log FROM usrp_superadmin;
REVOKE UPDATE ON ALL TABLES IN SCHEMA audit_log FROM usrp_superadmin;
REVOKE DELETE ON ALL TABLES IN SCHEMA audit_log FROM usrp_system_service;
REVOKE UPDATE ON ALL TABLES IN SCHEMA audit_log FROM usrp_system_service;

SELECT rolname FROM pg_roles 
WHERE rolname LIKE 'usrp_%' 
ORDER BY rolname;
