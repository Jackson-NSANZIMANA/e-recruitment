-- ══════════════════════════════════════════════════════════════════
-- 0044 — A clearance nobody could verify ends at a human (evaluation D2)
--
-- THE HOLE. Verifying an Irembo criminal-record certificate retries for ~15.5 s
-- and is then dead-lettered (ADR-025) so one stuck event cannot freeze its
-- partition. Nothing consumed the dead-letter topic, so an outage longer than
-- that left the citizen's checklist saying "we are verifying" for ever: the
-- verification row stayed PENDING, no officer was ever asked to look, and the
-- fact that the registry had been down lived only in a Kafka topic.
--
-- THE FIX, in this file, is the two engine-side facts the escalation needs:
--
--   1. `CLEARANCE_UNVERIFIED` becomes a legal REVIEW reason. It is deliberately
--      cause-neutral — "we could not verify it, a human must look" — because the
--      same landing place is correct for an Irembo outage, a network partition
--      or an unreadable registry response, and guessing between them in a CHECK
--      constraint would be guesswork written into the schema.
--
--   2. An escalation may never SUPERSEDE a verdict. The escalation is written
--      from the dead-letter observer, which can fire late (an operator replaying
--      an old DLQ message, a redelivery after a long rebalance). If the citizen
--      has meanwhile been CLEARED — or has corrected their number and been told
--      CORRECTION_NEEDED — layering "unverified, a human will look" on top would
--      regress a settled outcome. The row is append-only and the readers take
--      the LATEST row, so this is refused here rather than hoped for upstream.
--
-- The vocabulary itself is declared once in @usrp/shared-types
-- (CLEARANCE_REVIEW_REASONS) and enforced by three readers: this constraint,
-- application-service's amber queue and the edge-gateway's officer checklist.
--
-- Why not store the certificate number so a timer can retry instead? Because
-- keeping it is the single thing this table is designed NOT to do: the number is
-- held as an HMAC plus its last 4 precisely so a database dump cannot be used to
-- look citizens up. An outage must not be paid for with that property.
--
-- Run as usrp_admin AFTER db:migrate, rls/0001, rls/0040. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

DO $$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['rdf_ops', 'rnp_ops', 'rcs_ops'] LOOP

    -- ── 1. the vocabulary grows by exactly one reason ─────────────
    -- Dropped and re-added (rls/0040's idiom) so a database that applied the
    -- previous CHECK converges on this one; NULL-safe, as every term is either
    -- COALESCEd or only reached inside a CASE branch that has already matched.
    EXECUTE format('ALTER TABLE %I.clearance_certificate_verifications DROP CONSTRAINT IF EXISTS clearance_verif_shape_check', s);
    EXECUTE format($c$ALTER TABLE %I.clearance_certificate_verifications ADD CONSTRAINT clearance_verif_shape_check CHECK (
      CASE outcome
        WHEN 'CLEARED' THEN failure_code IS NULL AND cardinality(review_reasons) = 0
        WHEN 'REVIEW' THEN failure_code IS NULL
          AND cardinality(review_reasons) > 0
          AND review_reasons <@ ARRAY['CLEARANCE_CONTENT_REVIEW', 'IDENTITY_NAME_PARTIAL', 'IDENTITY_HOLDER_UNREADABLE', 'CLEARANCE_UNVERIFIED']::text[]
        WHEN 'CORRECTION_NEEDED' THEN cardinality(review_reasons) = 0
          AND COALESCE(failure_code IN ('CERTIFICATE_NUMBER_MALFORMED', 'CERTIFICATE_NOT_FOUND', 'CERTIFICATE_NOT_VALID',
                                         'CERTIFICATE_WRONG_TYPE', 'CERTIFICATE_EXPIRED', 'CERTIFICATE_NOT_BOUND'), false)
        WHEN 'PENDING' THEN cardinality(review_reasons) = 0 AND COALESCE(failure_code = 'REGISTRY_UNAVAILABLE', false)
        ELSE false
      END)$c$, s);

    -- ── 2. the write boundary, with the supersede guard ──────────
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.record_clearance_verification(
        p_application_id uuid,
        p_applicant_id uuid,
        p_reference_hmac text,
        p_reference_last4 text,
        p_certificate_type text,
        p_issued_on date,
        p_outcome text,
        p_failure_code text,
        p_review_reasons text[],
        p_binding jsonb,
        p_request_id text,
        p_correlation_id text
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_last record;
        v_reasons text[] := COALESCE(p_review_reasons, ARRAY[]::text[]);
      BEGIN
        -- caller: the shared backend login, as the vetting service role
        IF session_user <> 'usrp_app' OR current_setting('role', true) IS DISTINCT FROM 'usrp_vetting_service' THEN
          RAISE EXCEPTION 'clearance verification requires the vetting-service database role' USING ERRCODE = '42501';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM %1$I.applications AS app WHERE app.id = p_application_id AND app.applicant_id = p_applicant_id) THEN
          RETURN jsonb_build_object('outcome', 'REFUSED', 'reason', 'UNKNOWN_APPLICATION');
        END IF;

        SELECT v.reference_hmac, v.certificate_type, v.issued_on, v.outcome, v.failure_code, v.review_reasons
          INTO v_last
        FROM %1$I.clearance_certificate_verifications AS v
        WHERE v.application_id = p_application_id
        ORDER BY v.verified_at DESC, v.id DESC
        LIMIT 1;
        IF FOUND THEN
          -- Idempotent: a redelivered event that concludes the same thing records once.
          IF v_last.reference_hmac = p_reference_hmac
             AND v_last.certificate_type IS NOT DISTINCT FROM p_certificate_type
             AND v_last.issued_on IS NOT DISTINCT FROM p_issued_on
             AND v_last.outcome = p_outcome
             AND v_last.failure_code IS NOT DISTINCT FROM p_failure_code
             AND v_last.review_reasons = v_reasons THEN
            RETURN jsonb_build_object('outcome', 'ALREADY_RECORDED');
          END IF;

          -- An escalation (0044) may only follow an unresolved attempt. A late
          -- one — an operator replay, a redelivery after a long rebalance — must
          -- not overwrite a verdict the citizen already has.
          IF p_outcome = 'REVIEW'
             AND v_reasons = ARRAY['CLEARANCE_UNVERIFIED']::text[]
             AND v_last.outcome <> 'PENDING' THEN
            RETURN jsonb_build_object('outcome', 'REFUSED', 'reason', 'SUPERSEDES_VERDICT');
          END IF;
        END IF;

        INSERT INTO %1$I.clearance_certificate_verifications
          (application_id, reference_hmac, reference_last4, certificate_type, issued_on, outcome,
           failure_code, review_reasons, binding, upstream_trace_id, correlation_id)
        VALUES (p_application_id, p_reference_hmac, p_reference_last4, p_certificate_type, p_issued_on, p_outcome,
                p_failure_code, v_reasons, p_binding,
                CASE WHEN p_request_id ~ '^[A-Za-z0-9._:-]{1,64}$' THEN p_request_id END,
                CASE WHEN p_correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$' THEN p_correlation_id END);
        RETURN jsonb_build_object('outcome', 'RECORDED');
      END
      $body$;
    $f$, s);
    -- CREATE OR REPLACE keeps the owner and the ACL; re-asserted so a database
    -- that somehow lost the 0040 grants converges here too.
    EXECUTE format('ALTER FUNCTION %I.record_clearance_verification(uuid, uuid, text, text, text, date, text, text, text[], jsonb, text, text) OWNER TO usrp_clearance_owner', s);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.record_clearance_verification(uuid, uuid, text, text, text, date, text, text, text[], jsonb, text, text) FROM PUBLIC', s);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.record_clearance_verification(uuid, uuid, text, text, text, date, text, text, text[], jsonb, text, text) TO usrp_vetting_service', s);
  END LOOP;
END $$;

COMMIT;
