-- ══════════════════════════════════════════════════════════════════
-- 0042 — National ID hint column (encrypted_national_id_hint) · S12a, ADR-048 §2.1
--
-- Registries print a MASKED National ID next to a credential (SDMS:
-- studentNationalIdHint = first 4 + last 4 digits). Binding a credential to
-- its holder must compare that hint with the applicant's NID, but USRP never
-- stores the raw NID (only HMACs). This column holds exactly the 8 digits a
-- registry already shows publicly, ENCRYPTED AT REST (pgcrypto, same class as
-- the other PII columns), decrypted only by the system service under
-- app.encryption_key, NULLed on erasure with the rest of the identity PII.
--
-- Written by identity-service at verification (the only holder of the raw
-- NID). Nullable: identities verified before 0042 have no hint, and the
-- binding rule then reports the field NOT_COMPARED (never a contradiction).
--
-- Number: 0042, reserved for S12a in the README table (0041 is S12c's).
-- No new grant: inherits usrp_system_service's privileges on the table (0001).
-- Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE public_core.applicant_identities
  ADD COLUMN IF NOT EXISTS encrypted_national_id_hint text;

COMMENT ON COLUMN public_core.applicant_identities.encrypted_national_id_hint IS
  'pgcrypto(app.encryption_key)-encrypted first 4 + last 4 digits of the NID, '
  'for credential-to-identity binding against registry NID hints (ADR-048). '
  'Nullable for identities verified before rls/0042.';

COMMIT;
