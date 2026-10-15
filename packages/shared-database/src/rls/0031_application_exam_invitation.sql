-- ══════════════════════════════════════════════════════════════════
-- 0031 — Persist the signed exam invitation on the application (ADR-033)
--
-- ADR-009 made the exam QR an Ed25519-signed, offline-verifiable credential
-- (USRP-SLOT.v1.<claims>.<sig>) and deliberately kept it TRANSPORT-ONLY: it
-- rode SLOT_ASSIGNED and was never stored, pending a delivery channel. SMS is
-- not available, so the citizen had no way to obtain the QR at all. The portal
-- is now that channel, which requires the token to be stored.
--
--   qr_signed_token  the exact token scheduling signed. PII-free by
--                    construction (opaque ids + public venue/date). It is a
--                    credential, so: write-once (trigger), shape-checked, and
--                    readable only through the owner-scoped invitation read.
--
-- Applied to all three agency schemas. Run as usrp_admin AFTER 0030.
-- Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['rdf_ops', 'rnp_ops', 'rcs_ops'] LOOP
    EXECUTE format('ALTER TABLE %I.applications ADD COLUMN IF NOT EXISTS qr_signed_token text', s);

    EXECUTE format('ALTER TABLE %I.applications DROP CONSTRAINT IF EXISTS applications_qr_signed_token_shape_check', s);
    EXECUTE format(
      'ALTER TABLE %I.applications ADD CONSTRAINT applications_qr_signed_token_shape_check
         CHECK (qr_signed_token IS NULL OR (qr_signed_token LIKE %L AND length(qr_signed_token) <= 4096))',
      s, 'USRP-SLOT.v1.%');

    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.applications_exam_invitation_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF OLD.qr_signed_token IS NOT NULL
           AND NEW.qr_signed_token IS DISTINCT FROM OLD.qr_signed_token THEN
          RAISE EXCEPTION 'applications.qr_signed_token is immutable once issued'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END
      $body$;
    $f$, s);

    EXECUTE format('DROP TRIGGER IF EXISTS trg_applications_exam_invitation_immutable ON %I.applications', s);
    EXECUTE format(
      'CREATE TRIGGER trg_applications_exam_invitation_immutable
         BEFORE UPDATE ON %I.applications
         FOR EACH ROW EXECUTE FUNCTION %I.applications_exam_invitation_immutable()', s, s);
  END LOOP;
END $$;

COMMIT;
