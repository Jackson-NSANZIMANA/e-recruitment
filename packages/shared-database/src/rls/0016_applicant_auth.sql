-- ══════════════════════════════════════════════════════════════════
-- 0016 — Applicant auth store (OTP challenges + session writability)
--
-- The citizen half of the auth story (ADR-018). Officers log in with
-- passwords (0010), machines with client credentials (0015); a CITIZEN
-- authenticates with a one-time code sent to their NIDA-registered phone,
-- and on success receives an opaque, revocable DB session (owner D5) in the
-- long-dormant public_core.applicant_sessions table.
--
-- Two pieces:
--   1. applicant_otp_challenges — the short-lived OTP store. One row per
--      requested code: scrypt digest (NEVER the plaintext code), expiry
--      (minutes), attempt counter (lockout), consumed_at (single-use).
--      No raw phone number is stored here or anywhere — the destination
--      exists only in memory between the live NIDA lookup and the SMS send.
--   2. applicant_sessions writability — 0014 granted SELECT, DELETE to
--      usrp_system_service (erasure needs the hard-delete); issuing and
--      touching sessions needs INSERT, UPDATE too.
--
-- identity-service (running as usrp_system_service) owns the flow: it holds
-- the NIDA gateway, the NID hash key, and the PII boundary. Unlike the
-- officer/service credential stores (iam-only), this store is deliberately
-- system-role-scoped — the digests here are 6-digit codes that die in
-- minutes, not long-lived passwords; the blast radius of a read is one
-- five-minute window (noted in ADR-018).
--
-- Run as usrp_admin AFTER db:migrate and 0001. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS public_core.applicant_otp_challenges (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id uuid         NOT NULL REFERENCES public_core.applicant_identities(id),
  otp_hash     text         NOT NULL,   -- scrypt digest of the 6-digit code — NEVER plaintext
  expires_at   timestamptz  NOT NULL,
  attempts     integer      NOT NULL DEFAULT 0,
  consumed_at  timestamptz,
  created_at   timestamptz  NOT NULL DEFAULT now()
);

-- The verify path looks up the newest live challenge for an applicant.
CREATE INDEX IF NOT EXISTS idx_pc_otp_applicant
  ON public_core.applicant_otp_challenges (applicant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public_core.applicant_otp_challenges TO usrp_system_service;

ALTER TABLE public_core.applicant_otp_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.applicant_otp_challenges FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pc_otp_system ON public_core.applicant_otp_challenges;
CREATE POLICY pc_otp_system ON public_core.applicant_otp_challenges
  TO usrp_system_service USING (true) WITH CHECK (true);

-- Session issuance + sliding activity/termination (0014 already granted
-- SELECT, DELETE for the erasure hard-delete).
GRANT INSERT, UPDATE ON public_core.applicant_sessions TO usrp_system_service;

COMMIT;
