-- ══════════════════════════════════════════════════════════════════
-- 0006 — Age eligibility as a persisted vetting dimension (all 3 ops schemas)
--
-- Until now the application row carried only two vetting dimensions —
-- academic_status and criminal_clearance_status — so the lifecycle projection
-- could advance no further than CRIMINAL_CLEARANCE. The age gate produced only
-- an AUDIT_ENTRY shadow, with nowhere to land on the row and no applicationId-
-- bearing result event. This migration adds age as the THIRD projected
-- dimension, letting the projection reach the positive terminal
-- (DOCUMENT_REVIEW_GREEN) when age + academic + criminal all pass. See ADR-007.
--
-- Mirrors the existing academic block exactly (enum + status + verified_at +
-- detail jsonb), per ops schema. The age_eligibility_status enum values match
-- @usrp/shared-types AgeEligibilityStatus by design (no translation layer):
--   PENDING | ELIGIBLE | INELIGIBLE
--
-- age_eligibility_detail stores the gate's DOB-FREE evidence only (derived age,
-- applied band, verdict, reason) — the raw date of birth NEVER lands here, the
-- same protection the age AUDIT_ENTRY already observes (Law N° 058/2021).
--
-- No new grant needed: 0001 grants usrp_system_service SELECT/INSERT/UPDATE ON
-- ALL TABLES in each ops schema (table-level → new columns inherit it). Run as
-- usrp_admin AFTER db:migrate + 0001. Fully re-runnable (idempotent DO-block
-- enum create + ADD COLUMN IF NOT EXISTS).
-- ══════════════════════════════════════════════════════════════════
BEGIN;

DO $$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['rdf_ops', 'rnp_ops', 'rcs_ops'] LOOP
    -- Create the enum type in this schema if it does not already exist.
    IF NOT EXISTS (
      SELECT 1 FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname = 'age_eligibility_status' AND n.nspname = s
    ) THEN
      EXECUTE format(
        'CREATE TYPE %I.age_eligibility_status AS ENUM (%L, %L, %L)',
        s, 'PENDING', 'ELIGIBLE', 'INELIGIBLE'
      );
    END IF;

    -- Add the three age columns, mirroring the academic block.
    EXECUTE format(
      'ALTER TABLE %I.applications
         ADD COLUMN IF NOT EXISTS age_eligibility_status %I.age_eligibility_status NOT NULL DEFAULT %L',
      s, s, 'PENDING'
    );
    EXECUTE format(
      'ALTER TABLE %I.applications ADD COLUMN IF NOT EXISTS age_verified_at timestamptz',
      s
    );
    EXECUTE format(
      'ALTER TABLE %I.applications ADD COLUMN IF NOT EXISTS age_eligibility_detail jsonb',
      s
    );

    -- Index the new status column to match the existing academic/criminal ones.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%s_age_status ON %I.applications (age_eligibility_status)',
      split_part(s, '_', 1), s
    );
  END LOOP;
END$$;

COMMIT;
