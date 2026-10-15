-- ══════════════════════════════════════════════════════════════════
-- 0028 — Onboarding attempt lockout (ADR-029)
--
-- Citizen onboarding step 1 takes National ID + date of birth. A DOB is
-- guessable, and the edge limiter only has a per-minute window, so the
-- brake that actually bounds a guessing campaign must be DURABLE and keyed
-- by the person, not by the client address.
--
-- One row per National ID HASH (the keyed HMAC — never the raw NID, and no
-- foreign key: the identity row may not exist yet). A row is written only
-- when NIDA FOUND a Rwandan citizen and the DOB did not match, so unknown
-- NIDs cannot be used to grow this table.
--
--   failed_count      mismatches inside the current window
--   window_started_at start of that window (reset after it elapses)
--   locked_until      while in the future, step 1 answers the uniform
--                     "not confirmed" WITHOUT consulting NIDA — even for the
--                     correct DOB, so the lock cannot be probed.
--
-- identity-service (usrp_system_service) is the sole reader/writer.
-- Run as usrp_admin AFTER 0016. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS public_core.onboarding_attempts (
  national_id_hash  varchar(64) PRIMARY KEY,
  failed_count      integer     NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  window_started_at timestamptz NOT NULL,
  locked_until      timestamptz
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public_core.onboarding_attempts TO usrp_system_service;

ALTER TABLE public_core.onboarding_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.onboarding_attempts FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pc_onb_system ON public_core.onboarding_attempts;
CREATE POLICY pc_onb_system ON public_core.onboarding_attempts
  TO usrp_system_service USING (true) WITH CHECK (true);

COMMIT;
