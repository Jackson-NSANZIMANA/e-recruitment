-- ══════════════════════════════════════════════════════════════════
-- 0023 — the walk-in lane stages its events transactionally (ADR-025/027)
--
-- ADR-025 gave the digital front door a transactional outbox so a committed
-- state change could not lose the event that announces it. The walk-in lane
-- never got it: the officer's transaction committed the application and its
-- history row, and the service published APPLICANT_SUBMITTED on the bus
-- AFTERWARDS. A crash in between left a durable application that the
-- autonomous vetting pipeline had never been told about.
--
-- ADR-027 made that worse rather than better. Before it, an officer who
-- retried filed a SECOND application, which did emit an event — an accidental
-- recovery path. Now the retry is correctly refused ALREADY_APPLIED, so a
-- candidate stranded by a lost event stays stranded, and the only trace is a
-- citizen who was registered at the venue and never vetted.
--
-- The fix is to stage the event inside the officer's own transaction. That
-- requires the officer roles to be able to INSERT into the outbox, which they
-- could not: rls/0020 granted it to usrp_system_service alone.
--
-- Why not simply switch the walk-in write to the system role instead?
-- Because the officer role IS the cross-agency isolation mechanism (see
-- ports/walk-in-repository.ts): usrp_rdf_officer has no grant on rnp_ops or
-- rcs_ops, so the engine — not application code — guarantees a field officer
-- cannot touch a sibling agency's applications. Trading that away to avoid a
-- grant would be a bad bargain.
--
-- The grant is therefore as narrow as the lane it serves:
--   • INSERT only. Officers cannot read, amend or delete outbox rows; the
--     relay stays the sole reader and the sole marker of delivery.
--   • WITH CHECK pins the producer, so an officer session cannot stage a row
--     attributed to another service.
--   • All three officer roles are granted for symmetry with rls/0001, even
--     though ADR-012 confines walk-in to RDF today. A future RNP/RCS on-site
--     lane must not need a migration to be durable; the WITH CHECK is what
--     actually constrains the row.
-- ══════════════════════════════════════════════════════════════════

BEGIN;

GRANT INSERT ON public_core.event_outbox
  TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;

-- nextval() on the identity sequence is required for the INSERT itself.
-- SELECT is deliberately NOT granted: officers have no reason to read the
-- counter, and currval/lastval are session-local anyway.
GRANT USAGE ON SEQUENCE public_core.event_outbox_id_seq
  TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;

-- INSERT-only policy. No USING clause, so it grants no visibility: an officer
-- session can write a row and cannot read any row back, not even its own.
DROP POLICY IF EXISTS pc_event_outbox_officer_stage ON public_core.event_outbox;
CREATE POLICY pc_event_outbox_officer_stage ON public_core.event_outbox
  FOR INSERT
  TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer
  WITH CHECK (producer = 'application-service');

COMMIT;
