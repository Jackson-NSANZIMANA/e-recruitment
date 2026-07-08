-- ══════════════════════════════════════════════════════════════════
-- 0002 — Audit-log immutability enforcement
--
-- Makes the "immutable government audit trail" TRUE in the engine, not just
-- in a comment. The audit_log.audit_entries table's header has long CLAIMED
-- "No UPDATE or DELETE ever permitted ... Enforced at database role level" —
-- until now nothing enforced it. This closes that gap.
--
-- Two independent guards (belt AND suspenders), because either alone is
-- insufficient for a national forensic record under Law N° 058/2021:
--
--   1. ROLE GRANTS (belt): a dedicated INSERT+SELECT-only writer role. The
--      app can append and read the trail, but is never GRANTed UPDATE/DELETE,
--      so ordinary application paths physically cannot mutate history.
--
--   2. TRIGGER (suspenders): grants do NOT bind the table owner or a
--      superuser — a migration run, a `psql` as owner, or a compromised
--      superuser could still rewrite history. A BEFORE UPDATE/DELETE trigger
--      RAISEs unconditionally, so tampering is refused for EVERY role,
--      owner and superuser included. This is the real immutability guarantee.
--
-- Run as usrp_admin AFTER db:migrate (and alongside 0001). Re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

-- ── The audit writer role (NOLOGIN group; assumed via SET ROLE) ───
-- Mirrors the 0001 model: usrp_app carries no privilege of its own and
-- assumes this role per-request. The audit-service is the ONLY writer.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='usrp_audit_writer') THEN
    CREATE ROLE usrp_audit_writer NOLOGIN;
  END IF;
END$$;

-- usrp_app can assume the audit writer role (as it does the agency roles).
GRANT usrp_audit_writer TO usrp_app;

-- ── Grants: append + read ONLY. UPDATE and DELETE are deliberately, ─
-- conspicuously never granted — that omission is the point.
GRANT USAGE  ON SCHEMA audit_log TO usrp_audit_writer;
GRANT SELECT, INSERT ON audit_log.audit_entries TO usrp_audit_writer;
-- The id has a DEFAULT (gen_random_uuid); no sequence to grant. If a serial
-- is ever added, grant USAGE on its sequence here.

-- Belt-and-suspenders on the grant side too: strip any UPDATE/DELETE that a
-- prior GRANT ... ON ALL TABLES (e.g. a broad system-service grant) may have
-- handed this role. Idempotent; REVOKE of an absent privilege is a no-op.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log.audit_entries FROM usrp_audit_writer;

-- ── The immutability trigger (binds owner + superuser too) ────────
-- A trigger function that always refuses. SECURITY note: this fires for the
-- table owner and superusers as well — grants do not, which is exactly why
-- the trigger is here and not just the REVOKE above.
CREATE OR REPLACE FUNCTION audit_log.reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log.audit_entries is append-only: % is not permitted on the immutable audit trail (Law N° 058/2021)',
    TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Re-runnable: drop then recreate so the guarantee is idempotent.
DROP TRIGGER IF EXISTS trg_audit_entries_no_update ON audit_log.audit_entries;
CREATE TRIGGER trg_audit_entries_no_update
  BEFORE UPDATE ON audit_log.audit_entries
  FOR EACH ROW EXECUTE FUNCTION audit_log.reject_mutation();

DROP TRIGGER IF EXISTS trg_audit_entries_no_delete ON audit_log.audit_entries;
CREATE TRIGGER trg_audit_entries_no_delete
  BEFORE DELETE ON audit_log.audit_entries
  FOR EACH ROW EXECUTE FUNCTION audit_log.reject_mutation();

-- NOTE on TRUNCATE: a row-level trigger cannot intercept TRUNCATE. A
-- statement-level BEFORE TRUNCATE trigger closes that door too — TRUNCATE is
-- the one mutation that bypasses BEFORE UPDATE/DELETE.
DROP TRIGGER IF EXISTS trg_audit_entries_no_truncate ON audit_log.audit_entries;
CREATE TRIGGER trg_audit_entries_no_truncate
  BEFORE TRUNCATE ON audit_log.audit_entries
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log.reject_mutation();

COMMIT;
