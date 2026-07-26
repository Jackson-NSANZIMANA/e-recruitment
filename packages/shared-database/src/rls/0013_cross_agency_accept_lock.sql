-- ══════════════════════════════════════════════════════════════════
-- 0013 — cross-agency accept-lock backstop (ADR-014)
--
-- Invariant #1 at the positive terminal: ONE citizen may be ACCEPTED by
-- at most ONE agency. Enforcement is a compare-and-set on the shared
-- public_core.applicant_identities row inside the officer accept
-- transaction (the columns cross_agency_locked_at /
-- cross_agency_locked_by_agency / cross_agency_lock_reason exist since
-- baseline 0000 but had ZERO writers until this slice):
--
--   UPDATE public_core.applicant_identities SET cross_agency_locked_* …
--   WHERE id = $applicant AND cross_agency_locked_at IS NULL
--
-- The identity row is UNIQUE per citizen (national_id_hash UNIQUE), so
-- whoever stamps first wins and every later accept — any agency — sees
-- 0 rows updated and refuses (409 CROSS_AGENCY_LOCKED). Race-safety is
-- the row lock: concurrent accepts contend on the SAME identity row via
-- SELECT … FOR UPDATE, regardless of which ops schema their application
-- rows live in.
--
-- This file adds only a belt-and-suspenders CHECK: a lock must always
-- name the agency that holds it and why. The lock's mutual exclusion is
-- structural (one row per citizen, guarded single UPDATE) — no unique
-- index can add to it — but a partially-stamped lock (timestamp without
-- agency, or vice versa) would be a silent app-logic regression the
-- engine should refuse outright.
--
-- No new grants or policies: rls/0001 already gives officer roles
-- SELECT, UPDATE on applicant_identities, and the pc_ai_<agency> RLS
-- policies expose exactly the rows of citizens WITH an application in
-- the officer's own agency — which is precisely the accepting case.
--
-- Run as usrp_admin AFTER db:migrate. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

-- All three lock columns are stamped together, or none (both directions:
-- a lock without attribution and an attribution without a lock are both
-- app-logic bugs the engine must surface, not store).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_pc_ai_lock_all_or_nothing'
      AND conrelid = 'public_core.applicant_identities'::regclass
  ) THEN
    ALTER TABLE public_core.applicant_identities
      ADD CONSTRAINT ck_pc_ai_lock_all_or_nothing CHECK (
        (cross_agency_locked_at IS NULL
          AND cross_agency_locked_by_agency IS NULL
          AND cross_agency_lock_reason IS NULL)
        OR
        (cross_agency_locked_at IS NOT NULL
          AND cross_agency_locked_by_agency IS NOT NULL
          AND cross_agency_lock_reason IS NOT NULL)
      );
  END IF;
END$$;

COMMIT;
