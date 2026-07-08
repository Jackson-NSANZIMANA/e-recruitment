-- ══════════════════════════════════════════════════════════════════
-- 0003 — Per-agency processing-code sequences
--
-- The front door (application-service) mints a human-facing, anonymous
-- processing code for every application: "RDF-00001", "RNP-00001",
-- "RCS-00001" (zero-padded 5-digit). Officers see this code instead of a
-- name — so it must be UNIQUE within an agency and race-free under
-- concurrent submissions.
--
-- A Postgres SEQUENCE is the correct primitive: nextval() is atomic and
-- contention-free, unlike a SELECT max()+1 which races. One sequence per
-- agency keeps the numeric part dense and per-agency independent, and
-- lives in that agency's isolated ops schema — the same RLS boundary as
-- its applications table.
--
-- usrp_system_service (the role the front door assumes) is GRANTed USAGE
-- so it can call nextval(); the per-agency officer roles are granted USAGE
-- on their own agency's sequence only, preserving isolation.
--
-- Run as usrp_admin AFTER db:migrate and 0001/0002. Fully re-runnable:
-- CREATE SEQUENCE IF NOT EXISTS never resets an existing counter.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

-- ── The sequences, one per agency ops schema ──────────────────────
-- START 1 → first code is AGENCY-00001. No CYCLE: codes never repeat.
CREATE SEQUENCE IF NOT EXISTS rdf_ops.processing_code_seq AS bigint START 1 MINVALUE 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS rnp_ops.processing_code_seq AS bigint START 1 MINVALUE 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS rcs_ops.processing_code_seq AS bigint START 1 MINVALUE 1 NO CYCLE;

-- ── Grants ────────────────────────────────────────────────────────
-- The system service mints codes for every agency (it owns the write
-- path in the front door), so it needs USAGE on all three.
GRANT USAGE ON SEQUENCE rdf_ops.processing_code_seq TO usrp_system_service;
GRANT USAGE ON SEQUENCE rnp_ops.processing_code_seq TO usrp_system_service;
GRANT USAGE ON SEQUENCE rcs_ops.processing_code_seq TO usrp_system_service;

-- Each agency officer role may read/advance ONLY its own sequence — the
-- cross-agency isolation surface extends to code generation too.
GRANT USAGE ON SEQUENCE rdf_ops.processing_code_seq TO usrp_rdf_officer;
GRANT USAGE ON SEQUENCE rnp_ops.processing_code_seq TO usrp_rnp_officer;
GRANT USAGE ON SEQUENCE rcs_ops.processing_code_seq TO usrp_rcs_officer;

COMMIT;
