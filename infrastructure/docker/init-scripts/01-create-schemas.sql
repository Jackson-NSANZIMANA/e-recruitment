-- ══════════════════════════════════════════════════════════════════
-- USRP — Schema Creation
-- Four isolated schemas: public_core, rdf_ops, rnp_ops, rcs_ops
-- Plus: audit schema (append-only)
-- ══════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS public_core;
CREATE SCHEMA IF NOT EXISTS rdf_ops;
CREATE SCHEMA IF NOT EXISTS rnp_ops;
CREATE SCHEMA IF NOT EXISTS rcs_ops;
CREATE SCHEMA IF NOT EXISTS audit_log;

COMMENT ON SCHEMA public_core IS 'Shared applicant identity — NIDA-anchored, visible to all authorized services';
COMMENT ON SCHEMA rdf_ops IS 'Rwanda Defence Force — isolated recruitment operations';
COMMENT ON SCHEMA rnp_ops IS 'Rwanda National Police — isolated recruitment operations';
COMMENT ON SCHEMA rcs_ops IS 'Rwanda Correctional Service — isolated recruitment operations';
COMMENT ON SCHEMA audit_log IS 'Append-only immutable audit trail — no UPDATE or DELETE permitted';

SELECT schema_name FROM information_schema.schemata 
WHERE schema_name IN ('public_core','rdf_ops','rnp_ops','rcs_ops','audit_log')
ORDER BY schema_name;
