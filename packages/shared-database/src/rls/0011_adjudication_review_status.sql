-- ══════════════════════════════════════════════════════════════════
-- 0011 — ADJUDICATION_REVIEW application status (late-disqualification lane)
--
-- Settles the policy parked at application-service domain/lifecycle.ts: a
-- disqualifying verdict arriving AFTER the eligibility terminal (e.g. a late
-- criminal flag on an already-SLOT_ASSIGNED row) previously auto-REJECTED the
-- applicant off the backbone with no human in the loop. Owner decision
-- (2026-07-14, ADR-011): late/post-clearance disqualification routes to a NEW
-- ADJUDICATION_REVIEW status for HUMAN adjudication instead. It is deliberately
-- SEPARATE from DOCUMENT_REVIEW_AMBER: amber is routine document review; this
-- is a post-clearance security hold — distinct authority, distinct audit trail.
--
-- The value is inserted BEFORE 'REJECTED' so its position in the canonical
-- order (mirrored by shared-types APPLICATION_STATUSES) ranks ABOVE every
-- in-flight stage: the pure lifecycle's monotonic max-rank guard then holds a
-- row at ADJUDICATION_REVIEW against any redelivered vetting evidence — only
-- the officer adjudicate endpoint exits it (CLEAR restores / REJECT rejects).
--
-- No new grants: rls/0001 already gives usrp_system_service UPDATE on
-- applications (the projection writer) and the owning agency officer role
-- SELECT/INSERT/UPDATE on applications + document_records (verified live).
--
-- ALTER TYPE ... ADD VALUE cannot run inside a DO block (no dynamic-SQL path),
-- so the three schemas are written explicitly. Safe inside a transaction on
-- PG16 because the new value is not used within this same transaction.
--
-- Run as usrp_admin AFTER db:migrate and 0001. Fully re-runnable
-- (ADD VALUE IF NOT EXISTS).
-- ══════════════════════════════════════════════════════════════════
BEGIN;

ALTER TYPE rdf_ops.application_status ADD VALUE IF NOT EXISTS 'ADJUDICATION_REVIEW' BEFORE 'REJECTED';
ALTER TYPE rnp_ops.application_status ADD VALUE IF NOT EXISTS 'ADJUDICATION_REVIEW' BEFORE 'REJECTED';
ALTER TYPE rcs_ops.application_status ADD VALUE IF NOT EXISTS 'ADJUDICATION_REVIEW' BEFORE 'REJECTED';

COMMIT;
