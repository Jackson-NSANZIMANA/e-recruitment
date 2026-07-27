-- ══════════════════════════════════════════════════════════════════
-- 0018 — Stored contact for invitation delivery (encrypted_phone_number)
--
-- ADR-021 (owner D13): the citizen's NIDA-registered phone, captured at OTP
-- verification (identity-service — the only component that ever holds the raw
-- number) and stored pgcrypto-ENCRYPTED AT REST so notification-service can
-- deliver the exam-slot invitation for real. Legal basis: necessity (statutory
-- notification duty in the recruitment process the citizen initiated) — purpose
-- and retention documented in docs/compliance/dpia.md.
--
-- Distinct from phone_number_hash (stamped since ADR-018): the hash is the
-- lookup/verification digest; this column is the deliverable value. Decrypted
-- only under app.encryption_key by usrp_system_service, transaction-locally
-- (notification-service PgContactResolver). Nullable: only citizens who have
-- completed an OTP login have it; NULLed on erasure — both the citizen-demand
-- road (ADR-015) and the retention sweep (ADR-019), which share one
-- ErasureRepository. The 0014 erasure freeze covers this column automatically
-- (row-level, deleted_at-driven).
--
-- No new grant needed: the column inherits usrp_system_service's existing
-- SELECT/INSERT/UPDATE on applicant_identities (0001). Run as usrp_admin AFTER
-- db:migrate + 0001. Fully re-runnable (ADD COLUMN IF NOT EXISTS).
-- ══════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE public_core.applicant_identities
  ADD COLUMN IF NOT EXISTS encrypted_phone_number text;

COMMENT ON COLUMN public_core.applicant_identities.encrypted_phone_number IS
  'pgcrypto(app.encryption_key)-encrypted NIDA-registered phone, captured at OTP '
  'verification for invitation delivery (ADR-021). Distinct from phone_number_hash '
  '(the lookup digest). Nullable; NULLed on erasure.';

COMMIT;
