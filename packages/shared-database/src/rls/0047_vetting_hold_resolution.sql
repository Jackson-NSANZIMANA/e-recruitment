-- ══════════════════════════════════════════════════════════════════
-- 0047 — Vetting-hold resolution · D0 (Phase 0), ADR-051
--
-- THE DEFECT THIS SERVES (evaluation 2026-10-29, D10): the amber queue shows
-- every application held on a criminal-clearance UNDER_REVIEW or a NESA
-- NESA_REVIEW_REQUIRED, and NO officer operation could act on either. The queue
-- was a list of work the console could not do.
--
-- THE FIX is the lane-aware `adjudicate` verb (rls-free; shipped with #58) —
-- this migration adds the durable FACT of who resolved which held dimension.
--
-- WHY A COLUMN IS NEEDED, and not just the audit trail: separation of duties.
-- The officer who resolves a criminal OR academic hold may not also accept that
-- application (CLEARANCE_REVIEW_EXCLUDES_ACCEPTER), and the accept transaction
-- must answer "did this officer resolve ANY hold here?" with one locked read.
-- It is a SET, not a single slot: a row held in two dimensions can be resolved
-- by two officers, and a last-writer-wins column would let the first one accept.
--
-- The same fact closes a second hole: an automated verdict arriving AFTER a
-- human decided (a re-driven event, a redelivery) must not overwrite it. The
-- projection reads vetting_hold_resolved_dimensions and refuses to touch them.
--
-- ALL THREE AGENCIES, ONE MIGRATION. An agency-specific column that exists in
-- one schema and not the others is exactly the D1 class of defect, so the
-- cross-agency shape proof asserts these three columns exist in rdf_ops,
-- rnp_ops and rcs_ops (verify-cross-agency-columns.ts).
--
-- Number: 0047 (renumbered from 0045 at rebase onto rls/0043-0044), reserved for D0 in the programme README. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

DO $$
DECLARE
  schema_name text;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['rdf_ops', 'rnp_ops', 'rcs_ops']
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.applications
         ADD COLUMN IF NOT EXISTS vetting_hold_resolvers uuid[] NOT NULL DEFAULT ''{}'',
         ADD COLUMN IF NOT EXISTS vetting_hold_resolved_dimensions text[] NOT NULL DEFAULT ''{}'',
         ADD COLUMN IF NOT EXISTS vetting_hold_resolved_at timestamptz', schema_name);

    -- A closed set, enforced where a write that bypassed the service is still refused.
    EXECUTE format('ALTER TABLE %I.applications DROP CONSTRAINT IF EXISTS %I', schema_name,
      schema_name || '_vetting_hold_dimensions_check');
    EXECUTE format(
      'ALTER TABLE %I.applications ADD CONSTRAINT %I
         CHECK (vetting_hold_resolved_dimensions <@ ARRAY[''CRIMINAL'', ''ACADEMIC'']::text[])',
      schema_name, schema_name || '_vetting_hold_dimensions_check');

    -- Resolvers, dimensions and the timestamp are all-or-nothing: a half-stamped
    -- row would make the separation-of-duties read ambiguous.
    EXECUTE format('ALTER TABLE %I.applications DROP CONSTRAINT IF EXISTS %I', schema_name,
      schema_name || '_vetting_hold_resolution_complete');
    EXECUTE format(
      'ALTER TABLE %I.applications ADD CONSTRAINT %I
         CHECK ((cardinality(vetting_hold_resolvers) = 0) = (vetting_hold_resolved_at IS NULL)
                AND (cardinality(vetting_hold_resolved_dimensions) = 0) = (vetting_hold_resolved_at IS NULL))',
      schema_name, schema_name || '_vetting_hold_resolution_complete');
  END LOOP;
END
$$;

COMMIT;
