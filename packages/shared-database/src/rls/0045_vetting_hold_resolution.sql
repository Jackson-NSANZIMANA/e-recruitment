-- ══════════════════════════════════════════════════════════════════
-- 0045 — Vetting-hold resolution · D0 (Phase 0), ADR-051
--
-- THE DEFECT THIS SERVES (evaluation 2026-10-29, D10): the amber queue shows
-- every application held on a criminal-clearance UNDER_REVIEW or a NESA
-- NESA_REVIEW_REQUIRED, and NO officer operation could act on either. The queue
-- was a list of work the console could not do.
--
-- THE FIX is an officer verb (POST /v1/applications/vetting-hold) that rewrites
-- the HELD EVIDENCE (criminal_clearance_status / academic_status) and lets the
-- existing pure lifecycle derive the next status from all three verdicts.
--
-- WHY A COLUMN IS NEEDED, and not just the audit trail: separation of duties.
-- The officer who resolves a criminal hold may not also accept that application
-- (CLEARANCE_REVIEW_EXCLUDES_ACCEPTER), and the accept transaction must be able
-- to answer "who resolved it?" with one locked read — not by reconstructing an
-- event history at admission time. The resolver is a durable fact about the row.
--
-- ALL THREE AGENCIES, ONE MIGRATION. An agency-specific column that exists in
-- one schema and not the others is exactly the D1 class of defect, so the
-- cross-agency shape proof asserts these three columns exist in rdf_ops,
-- rnp_ops and rcs_ops (verify-cross-agency-columns.ts).
--
-- Number: 0045, reserved for D0 in the programme README. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

DO $$
DECLARE
  schema_name text;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['rdf_ops', 'rnp_ops', 'rcs_ops']
  LOOP
    -- Who resolved a HELD vetting dimension on this application, and when.
    -- Nullable: most applications are never held.
    EXECUTE format(
      'ALTER TABLE %I.applications
         ADD COLUMN IF NOT EXISTS vetting_hold_resolved_by uuid,
         ADD COLUMN IF NOT EXISTS vetting_hold_resolved_at timestamptz,
         ADD COLUMN IF NOT EXISTS vetting_hold_dimension text', schema_name);

    -- The dimension is a closed set, enforced where a write that bypassed the
    -- service would still be refused.
    EXECUTE format(
      'ALTER TABLE %I.applications DROP CONSTRAINT IF EXISTS %I', schema_name,
      schema_name || '_vetting_hold_dimension_check');
    EXECUTE format(
      'ALTER TABLE %I.applications ADD CONSTRAINT %I
         CHECK (vetting_hold_dimension IS NULL OR vetting_hold_dimension IN (''CRIMINAL'', ''ACADEMIC''))',
      schema_name, schema_name || '_vetting_hold_dimension_check');

    -- "Resolved by X at T" is all-or-nothing: a half-stamped row would make the
    -- separation-of-duties read ambiguous.
    EXECUTE format(
      'ALTER TABLE %I.applications DROP CONSTRAINT IF EXISTS %I', schema_name,
      schema_name || '_vetting_hold_resolution_complete');
    EXECUTE format(
      'ALTER TABLE %I.applications ADD CONSTRAINT %I
         CHECK ((vetting_hold_resolved_by IS NULL) = (vetting_hold_resolved_at IS NULL))',
      schema_name, schema_name || '_vetting_hold_resolution_complete');
  END LOOP;
END
$$;

COMMIT;
