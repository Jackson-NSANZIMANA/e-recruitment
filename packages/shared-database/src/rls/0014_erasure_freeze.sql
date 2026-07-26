-- ══════════════════════════════════════════════════════════════════
-- 0014 — Erasure freeze + session-erasure grants (ADR-015)
--
-- Right-to-erasure (Law N° 058/2021) is implemented as a TOMBSTONE
-- OVERWRITE of public_core.applicant_identities executed by
-- identity-service as usrp_system_service: the five encrypted_* PII
-- columns are overwritten, national_id_hash is rotated to a random
-- unlinkable value, phone/biometric/nida columns are NULLed, and
-- deleted_at is stamped — all in ONE UPDATE. (No backups exist in this
-- deployment tier, so overwrite IS destruction; per-citizen-DEK
-- crypto-shredding is the flagged upgrade path BEFORE any backup
-- infrastructure lands — see ADR-015.)
--
-- This file adds the engine guarantee the workflow needs: erasure is
-- IRREVERSIBLE. A trigger (suspenders, same doctrine as 0002/0007 —
-- grants do not bind owner/superuser, triggers bind everyone) refuses:
--
--   • any UPDATE of a row whose deleted_at is already set — an erased
--     citizen cannot be un-erased, re-identified, or have PII written
--     back;
--   • any UPDATE that CLEARS deleted_at.
--
-- The one legal mutation of deleted_at is NULL → not-NULL: the erasure
-- stamp itself. DELETE of identity rows is not additionally guarded
-- here: FKs from every ops schema already make deleting a citizen with
-- any application impossible, and hard-deleting an applicationless row
-- is not the erasure path.
--
-- Also grants usrp_system_service SELECT, DELETE on
-- public_core.applicant_sessions (zero writers today; erasure must
-- still clear any session rows — token, ip_address, user_agent are
-- personal data). First grant on this table; RLS deliberately not
-- enabled on it until it gains real writers.
--
-- RESIDUAL (same as 0002/0007): superuser can DISABLE TRIGGER or SET
-- session_replication_role = replica. Services run as non-superuser
-- usrp_app; the self-checks use that escape hatch locally for teardown.
--
-- Run as usrp_admin AFTER db:migrate + 0001. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION public_core.reject_erased_identity_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'applicant identity % is erased (deleted_at %) and frozen: UPDATE is not permitted after right-to-erasure execution (Law N° 058/2021)',
      OLD.id, OLD.deleted_at USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL THEN
    -- Unreachable given the guard above; kept explicit so the intent
    -- (deleted_at may only ever go NULL → not-NULL) survives edits.
    RAISE EXCEPTION
      'deleted_at may not be cleared: erasure is irreversible (Law N° 058/2021)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pc_ai_erasure_freeze ON public_core.applicant_identities;
CREATE TRIGGER trg_pc_ai_erasure_freeze
  BEFORE UPDATE ON public_core.applicant_identities
  FOR EACH ROW EXECUTE FUNCTION public_core.reject_erased_identity_mutation();

-- Session rows are personal data (token, ip, user-agent) — erasure
-- deletes them. system_service is the only role that may.
GRANT SELECT, DELETE ON public_core.applicant_sessions TO usrp_system_service;

COMMIT;
