-- ══════════════════════════════════════════════════════════════════
-- 0043 — Cross-agency column parity for the two PLATFORM-WIDE columns
--
-- THE DEFECT THIS CLOSES (evaluation D1, D12). Three agencies share one set of
-- application and field-score adapters. A column that exists in `rdf_ops` only,
-- and is written or read by that shared code, is not a cosmetic divergence: the
-- statement raises 42703 *for two agencies and nobody else*, and the failure
-- mode is silent because every proof that drives the path is an RDF proof (the
-- pilot agency).
--
-- D1  rnp_ops/rcs_ops.applications had no sms_notification_status. The invitation
--     projection UPDATEs it in the same transaction that moves the row to
--     PHYSICAL_TEST_SCHEDULED, so an RNP/RCS slot invitation was SENT, the
--     transaction rolled back, the row never left SLOT_ASSIGNED, and the event
--     was dead-lettered after six retries.
-- D12 rnp_ops/rcs_ops.physical_test_scores had no sync_conflict_resolution. The
--     CRDT log and its adjudication are agency-agnostic, so an RNP/RCS conflict
--     could be created and never resolved.
--
-- ── HOW A DIVERGENCE IS CLASSIFIED (the rule this migration applies) ──
--
--   PLATFORM-WIDE capability  → the column belongs in ALL THREE schemas, and
--                               rls/0044's parity proof keeps it there.
--   AGENCY-SPECIFIC process   → the column stays in one schema BY DESIGN and
--                               the shared code must branch on the agency.
--
-- Both columns here are platform-wide. Delivery status is how the platform
-- records what it told a citizen, and conflict resolution is how it records an
-- officer's adjudication; neither is a property of RDF's process. The genuinely
-- agency-specific columns — RDF's walk-in lane and in-house medical board, RCS's
-- notarisation and celibacy certificate, RNP's threshold and registration DPU —
-- stay where they are and are declared in rls/0044's allowlist with a reason.
--
-- DEFAULTS AND TYPES ARE COPIED FROM rdf_ops BY IDENTICAL TEXT, not re-invented:
-- the three schemas are read by one adapter, so a varchar(50) here and
-- varchar(20) there is the same class of bug one round later.
--
-- Additive and re-runnable (IF NOT EXISTS). Run as usrp_admin AFTER db:migrate.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

-- D1: the SMS delivery status of a slot invitation (varchar(20), nullable —
-- rdf_ops' shape; the closed set is DELIVERED | FAILED | PENDING_NO_CONTACT).
ALTER TABLE rnp_ops.applications
  ADD COLUMN IF NOT EXISTS sms_notification_status varchar(20);

ALTER TABLE rcs_ops.applications
  ADD COLUMN IF NOT EXISTS sms_notification_status varchar(20);

-- D12: the officer's adjudication of a concurrent-capture conflict
-- (varchar(50), nullable — rdf_ops' shape; the value is a free label ≤50 chars).
ALTER TABLE rnp_ops.physical_test_scores
  ADD COLUMN IF NOT EXISTS sync_conflict_resolution varchar(50);

ALTER TABLE rcs_ops.physical_test_scores
  ADD COLUMN IF NOT EXISTS sync_conflict_resolution varchar(50);

COMMIT;
