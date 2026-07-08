-- ══════════════════════════════════════════════════════════════════
-- 0007 — Application status-history immutability enforcement
--
-- Mirrors 0002 (audit-log immutability) for the per-agency
-- <schema>.application_status_history tables. These record every top-level
-- application status transition (null→SUBMITTED at the front door, then each
-- vetting advance/rejection projected by application-service). They are the
-- application's forensic timeline under Law N° 058/2021 and must be append-only
-- — until now that was convention only (the projection only ever INSERTs, but
-- nothing STOPPED an UPDATE/DELETE).
--
-- Two independent guards, exactly as 0002:
--
--   1. ROLE GRANTS (belt): strip UPDATE/DELETE/TRUNCATE from every role that
--      writes these tables (usrp_system_service, and each agency officer on its
--      own schema). 0001 granted SELECT,INSERT,UPDATE ON ALL TABLES — the
--      UPDATE included the history tables; this revokes it. The projection
--      only appends, so nothing legitimate loses a capability.
--
--   2. TRIGGER (suspenders): grants do NOT bind the table owner or a superuser.
--      A BEFORE UPDATE/DELETE (row) + BEFORE TRUNCATE (statement) trigger RAISEs
--      unconditionally, refusing tampering for EVERY role, owner and superuser
--      included. That is the real immutability guarantee.
--
-- RESIDUAL (same as 0002): a superuser can still ALTER TABLE ... DISABLE TRIGGER
-- or SET session_replication_role = replica. Run services as the non-owner,
-- non-superuser usrp_app; treat superuser access as an HSM/deployment concern.
-- (Repeatable test teardown that must delete history rows uses exactly that
-- superuser escape hatch, deliberately and locally — see the self-checks.)
--
-- Written out per schema (not a loop) on purpose: a compliance migration should
-- be trivially auditable line by line. Run as usrp_admin AFTER db:migrate + 0001
-- (needs the officer/system roles to exist). Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

-- ── rdf_ops ───────────────────────────────────────────────────────
REVOKE UPDATE, DELETE, TRUNCATE ON rdf_ops.application_status_history
  FROM usrp_system_service, usrp_rdf_officer;

CREATE OR REPLACE FUNCTION rdf_ops.reject_status_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'rdf_ops.application_status_history is append-only: % is not permitted on the immutable status-history trail (Law N° 058/2021)',
    TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_rdf_status_history_no_update ON rdf_ops.application_status_history;
CREATE TRIGGER trg_rdf_status_history_no_update
  BEFORE UPDATE ON rdf_ops.application_status_history
  FOR EACH ROW EXECUTE FUNCTION rdf_ops.reject_status_history_mutation();

DROP TRIGGER IF EXISTS trg_rdf_status_history_no_delete ON rdf_ops.application_status_history;
CREATE TRIGGER trg_rdf_status_history_no_delete
  BEFORE DELETE ON rdf_ops.application_status_history
  FOR EACH ROW EXECUTE FUNCTION rdf_ops.reject_status_history_mutation();

DROP TRIGGER IF EXISTS trg_rdf_status_history_no_truncate ON rdf_ops.application_status_history;
CREATE TRIGGER trg_rdf_status_history_no_truncate
  BEFORE TRUNCATE ON rdf_ops.application_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION rdf_ops.reject_status_history_mutation();

-- ── rnp_ops ───────────────────────────────────────────────────────
REVOKE UPDATE, DELETE, TRUNCATE ON rnp_ops.application_status_history
  FROM usrp_system_service, usrp_rnp_officer;

CREATE OR REPLACE FUNCTION rnp_ops.reject_status_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'rnp_ops.application_status_history is append-only: % is not permitted on the immutable status-history trail (Law N° 058/2021)',
    TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_rnp_status_history_no_update ON rnp_ops.application_status_history;
CREATE TRIGGER trg_rnp_status_history_no_update
  BEFORE UPDATE ON rnp_ops.application_status_history
  FOR EACH ROW EXECUTE FUNCTION rnp_ops.reject_status_history_mutation();

DROP TRIGGER IF EXISTS trg_rnp_status_history_no_delete ON rnp_ops.application_status_history;
CREATE TRIGGER trg_rnp_status_history_no_delete
  BEFORE DELETE ON rnp_ops.application_status_history
  FOR EACH ROW EXECUTE FUNCTION rnp_ops.reject_status_history_mutation();

DROP TRIGGER IF EXISTS trg_rnp_status_history_no_truncate ON rnp_ops.application_status_history;
CREATE TRIGGER trg_rnp_status_history_no_truncate
  BEFORE TRUNCATE ON rnp_ops.application_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION rnp_ops.reject_status_history_mutation();

-- ── rcs_ops ───────────────────────────────────────────────────────
REVOKE UPDATE, DELETE, TRUNCATE ON rcs_ops.application_status_history
  FROM usrp_system_service, usrp_rcs_officer;

CREATE OR REPLACE FUNCTION rcs_ops.reject_status_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'rcs_ops.application_status_history is append-only: % is not permitted on the immutable status-history trail (Law N° 058/2021)',
    TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_rcs_status_history_no_update ON rcs_ops.application_status_history;
CREATE TRIGGER trg_rcs_status_history_no_update
  BEFORE UPDATE ON rcs_ops.application_status_history
  FOR EACH ROW EXECUTE FUNCTION rcs_ops.reject_status_history_mutation();

DROP TRIGGER IF EXISTS trg_rcs_status_history_no_delete ON rcs_ops.application_status_history;
CREATE TRIGGER trg_rcs_status_history_no_delete
  BEFORE DELETE ON rcs_ops.application_status_history
  FOR EACH ROW EXECUTE FUNCTION rcs_ops.reject_status_history_mutation();

DROP TRIGGER IF EXISTS trg_rcs_status_history_no_truncate ON rcs_ops.application_status_history;
CREATE TRIGGER trg_rcs_status_history_no_truncate
  BEFORE TRUNCATE ON rcs_ops.application_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION rcs_ops.reject_status_history_mutation();

COMMIT;
