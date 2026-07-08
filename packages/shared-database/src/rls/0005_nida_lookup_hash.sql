-- ══════════════════════════════════════════════════════════════════
-- 0005 — G2G subject hash column (encrypted_nida_lookup_hash)
--
-- USRP stores two different hashes of a citizen's National ID:
--   • national_id_hash          = HMAC(USRP-private key, NID) — the internal,
--                                 system-wide applicant key (already present).
--   • encrypted_nida_lookup_hash = HMAC(NIDA-shared secret, NID) — the G2G
--                                 subject token every government authority
--                                 (NIDA/HEC/RIB) recognises for this citizen.
--
-- The second is required to bind an externally-issued credential to its
-- holder — e.g. HEC verifies a degree belongs to the person by matching this
-- hash. USRP never stores the raw NID, so this token must be captured at
-- verification time (identity-service, the only holder of the raw NID) and
-- re-presented later by G2G credential checks.
--
-- It is a citizen-linked, externally-meaningful identifier, so it is stored
-- ENCRYPTED AT REST via pgcrypto — same protection class as the PII columns,
-- decrypted only under app.encryption_key by the system service. Nullable:
-- identities created before this column predate it (backfill-safe).
--
-- No new grant needed: the column inherits usrp_system_service's existing
-- SELECT/INSERT/UPDATE on applicant_identities (0001). Run as usrp_admin
-- AFTER db:migrate + 0001. Fully re-runnable (ADD COLUMN IF NOT EXISTS).
-- ══════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE public_core.applicant_identities
  ADD COLUMN IF NOT EXISTS encrypted_nida_lookup_hash text;

COMMENT ON COLUMN public_core.applicant_identities.encrypted_nida_lookup_hash IS
  'pgcrypto(app.encryption_key)-encrypted HMAC(NIDA-shared secret, NID): the G2G '
  'subject token for cross-authority credential binding (HEC/RIB). Distinct from '
  'the USRP-private national_id_hash. Nullable for rows created before 0005.';

COMMIT;
