-- ══════════════════════════════════════════════════════════════════
-- 0012 — RNP medical-certificate columns (tri-agency medical, ADR-013)
--
-- Retires the last agency dead-end in the funnel: medicalReview returned
-- 501 UNSUPPORTED_AGENCY for RNP/RCS because the three agencies model
-- medical review differently (verified live 2026-07-12):
--   • rdf_ops — in-house medical BOARD: medical_reviewed_by_id/_at +
--     medical_fitness_status (an RDF officer records a fitness verdict).
--   • rcs_ops — government-physician CERTIFICATE: medical_cert_verified/
--     _verified_at/_physician_name (an officer verifies a brought document).
--   • rnp_ops — NOTHING.
--
-- Owner decision (2026-07-19, ADR-013): RNP mirrors the RCS certificate
-- model byte-for-byte. Evidence from the recruitment announcements (vision
-- archive): RNP CADET_OFFICER requires a "Medical certificate approved by
-- a recognized government doctor" — the same government-physician
-- certificate flow as RCS ("issued by an authorized Government physician").
-- RDF alone runs an in-house board. So the platform models TWO modes
-- (BOARD for RDF, CERTIFICATE for RNP+RCS), not three bespoke ones — and
-- deliberately does NOT unify RDF onto certificates, which would erase a
-- genuinely different real-world process.
--
-- No enum change: MEDICAL_REVIEW and FINAL_SHORTLIST already exist in all
-- three application_status enums (verified via pg_enum). No new grants:
-- rls/0001's table-level GRANTs on rnp_ops.applications already cover the
-- owning officer role and usrp_system_service.
--
-- Run as usrp_admin AFTER db:migrate. Fully re-runnable (IF NOT EXISTS).
-- ══════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE rnp_ops.applications
  ADD COLUMN IF NOT EXISTS medical_cert_verified boolean DEFAULT false;

ALTER TABLE rnp_ops.applications
  ADD COLUMN IF NOT EXISTS medical_cert_verified_at timestamptz;

ALTER TABLE rnp_ops.applications
  ADD COLUMN IF NOT EXISTS medical_cert_physician_name varchar(200);

COMMIT;
