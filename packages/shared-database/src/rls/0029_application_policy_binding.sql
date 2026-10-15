-- ══════════════════════════════════════════════════════════════════
-- 0029 — Application ↔ policy-version binding (BUILD-002)
--
-- An application must carry the exact, immutable policy version that
-- governed it, and the decision-relevant evaluation date. Downstream
-- consumers (age, education, vetting) must read THESE — not "today's
-- configuration" and not the wall clock at consumer-execution time — so a
-- delayed or replayed event cannot change an outcome.
--
--   policy_version_id  the campaign's current policy version AT SUBMISSION
--                      (NULL only for campaigns published before BUILD-001
--                      or filed by walk-in/legacy lanes — never inferred)
--   evaluation_date    calendar date (Africa/Kigali) of submission
--
-- Both are written once at INSERT by the front door and are never updated
-- by any application role (no UPDATE grant on these columns is added; the
-- columns are covered by the existing row-level grants, so immutability is
-- additionally enforced by the trigger below).
--
-- Run as usrp_admin AFTER 0028. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['rdf_ops', 'rnp_ops', 'rcs_ops'] LOOP
    EXECUTE format(
      'ALTER TABLE %I.applications
         ADD COLUMN IF NOT EXISTS policy_version_id uuid
           REFERENCES public_core.campaign_policy_versions(id),
         ADD COLUMN IF NOT EXISTS evaluation_date date', s);

    -- Write-once: once set, neither column may change.
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.applications_policy_binding_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF OLD.policy_version_id IS NOT NULL
           AND NEW.policy_version_id IS DISTINCT FROM OLD.policy_version_id THEN
          RAISE EXCEPTION 'applications.policy_version_id is immutable once set'
            USING ERRCODE = '23514';
        END IF;
        IF OLD.evaluation_date IS NOT NULL
           AND NEW.evaluation_date IS DISTINCT FROM OLD.evaluation_date THEN
          RAISE EXCEPTION 'applications.evaluation_date is immutable once set'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END
      $body$;
    $f$, s);

    EXECUTE format('DROP TRIGGER IF EXISTS trg_applications_policy_binding_immutable ON %I.applications', s);
    EXECUTE format(
      'CREATE TRIGGER trg_applications_policy_binding_immutable
         BEFORE UPDATE ON %I.applications
         FOR EACH ROW EXECUTE FUNCTION %I.applications_policy_binding_immutable()', s, s);
  END LOOP;
END $$;

COMMIT;
