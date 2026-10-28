-- ══════════════════════════════════════════════════════════════════
-- 0040 — Criminal clearance by Irembo certificate (S12b · ADR-048 §2.3-2.4)
--
-- One append-only table per agency records what verifying an applicant's
-- Irembo criminal-record certificate concluded:
--
--   <agency>_ops.clearance_certificate_verifications
--
-- It stores NO NAME AND NO DATE OF BIRTH (no such column exists, and the
-- guard trigger rejects unknown binding keys). The certificate number is held
-- as an HMAC (under a service secret, so it cannot be dictionary-attacked
-- from a database dump) plus its last 4 characters; the rest is closed codes:
-- the certificate type, its issue date, the outcome, a correctable failure
-- code or review reasons, the per-field binding results, the registry's
-- trace id.
--
-- WRITES go ONLY through <agency>_ops.record_clearance_verification(…),
-- SECURITY DEFINER, owned by the NOLOGIN BYPASSRLS usrp_clearance_owner,
-- EXECUTE for the NOLOGIN usrp_vetting_service alone. The function re-checks,
-- in the engine, that the session login is usrp_app and the active role is
-- usrp_vetting_service, and that the application exists in THIS agency. It is
-- idempotent: a redelivered event that concludes the same thing is
-- ALREADY_RECORDED. Rows are append-only (trigger, also for the owner).
--
-- READS: the agency's officer role (the amber queue and the application
-- detail) and usrp_system_service (the citizen's own checklist, which scopes by
-- the session subject). Nothing else has a policy; the blanket grants of
-- rls/0001 are re-applied on every bootstrap, and RLS and the triggers hold.
--
-- Retention follows the application record (ADR-048 §2.4).
--
-- Run as usrp_admin AFTER db:migrate, 0001, 0033, 0034. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

-- ── Roles ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usrp_vetting_service') THEN
    CREATE ROLE usrp_vetting_service NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usrp_clearance_owner') THEN
    CREATE ROLE usrp_clearance_owner NOLOGIN BYPASSRLS;
  END IF;
END$$;
ALTER ROLE usrp_vetting_service WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOLOGIN NOBYPASSRLS;
ALTER ROLE usrp_clearance_owner WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN BYPASSRLS;

-- The command owner is never a member of anything, never assumable.
DO $$
DECLARE
  v_membership record;
BEGIN
  FOR v_membership IN
    SELECT granted.rolname AS granted_role, member.rolname AS member_role
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE granted.rolname = 'usrp_clearance_owner'
       OR member.rolname = 'usrp_clearance_owner'
  LOOP
    EXECUTE format('REVOKE %I FROM %I', v_membership.granted_role, v_membership.member_role);
  END LOOP;
END$$;

-- The shared backend login assumes the service role (like every service role).
GRANT usrp_vetting_service TO usrp_app;
GRANT USAGE ON SCHEMA public_core TO usrp_vetting_service, usrp_clearance_owner;

-- ── Per agency ────────────────────────────────────────────────────
DO $$
DECLARE
  s text;
  a text;
  officer text;
BEGIN
  FOREACH s IN ARRAY ARRAY['rdf_ops', 'rnp_ops', 'rcs_ops'] LOOP
    a := split_part(s, '_', 1);
    officer := format('usrp_%s_officer', a);

    EXECUTE format($t$
      CREATE TABLE IF NOT EXISTS %1$I.clearance_certificate_verifications (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id   uuid NOT NULL REFERENCES %1$I.applications (id),
        reference_hmac   char(64) NOT NULL,
        reference_last4  char(4) NOT NULL,
        certificate_type varchar(64),
        issued_on        date,
        outcome          varchar(24) NOT NULL,
        failure_code     varchar(48),
        review_reasons   text[] NOT NULL DEFAULT ARRAY[]::text[],
        binding          jsonb,
        source           varchar(24) NOT NULL DEFAULT 'IREMBO_CERTIFICATE',
        upstream_trace_id varchar(64),
        verified_at      timestamptz NOT NULL DEFAULT now(),
        correlation_id   varchar(128),
        CONSTRAINT clearance_verif_hmac_check CHECK (reference_hmac ~ '^[0-9a-f]{64}$'),
        CONSTRAINT clearance_verif_last4_check CHECK (reference_last4 ~ '^[A-Z0-9*]{4}$'),
        CONSTRAINT clearance_verif_type_check CHECK (certificate_type IS NULL OR certificate_type ~ '^[A-Z0-9_]{1,64}$'),
        CONSTRAINT clearance_verif_source_check CHECK (source IN ('IREMBO_CERTIFICATE')),
        CONSTRAINT clearance_verif_trace_check CHECK (upstream_trace_id IS NULL OR upstream_trace_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
        CONSTRAINT clearance_verif_correlation_check CHECK (correlation_id IS NULL OR correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
        CONSTRAINT clearance_verif_outcome_check CHECK (outcome IN ('CLEARED', 'REVIEW', 'CORRECTION_NEEDED', 'PENDING'))
      )
    $t$, s);

    -- NULL-safe: every nullable term is COALESCEd to false (a CHECK that evaluates
    -- to NULL passes). Dropped and re-added so a database that applied an earlier
    -- draft converges.
    EXECUTE format('ALTER TABLE %I.clearance_certificate_verifications DROP CONSTRAINT IF EXISTS clearance_verif_shape_check', s);
    EXECUTE format($c$ALTER TABLE %I.clearance_certificate_verifications ADD CONSTRAINT clearance_verif_shape_check CHECK (
      CASE outcome
        WHEN 'CLEARED' THEN failure_code IS NULL AND cardinality(review_reasons) = 0
        WHEN 'REVIEW' THEN failure_code IS NULL
          AND cardinality(review_reasons) > 0
          AND review_reasons <@ ARRAY['CLEARANCE_CONTENT_REVIEW', 'IDENTITY_NAME_PARTIAL', 'IDENTITY_HOLDER_UNREADABLE']::text[]
        WHEN 'CORRECTION_NEEDED' THEN cardinality(review_reasons) = 0
          AND COALESCE(failure_code IN ('CERTIFICATE_NUMBER_MALFORMED', 'CERTIFICATE_NOT_FOUND', 'CERTIFICATE_NOT_VALID',
                                         'CERTIFICATE_WRONG_TYPE', 'CERTIFICATE_EXPIRED', 'CERTIFICATE_NOT_BOUND'), false)
        WHEN 'PENDING' THEN cardinality(review_reasons) = 0 AND COALESCE(failure_code = 'REGISTRY_UNAVAILABLE', false)
        ELSE false
      END)$c$, s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_clearance_verif_application ON %I.clearance_certificate_verifications (application_id, verified_at DESC)', a, s);

    -- ── grants ──────────────────────────────────────────────────
    EXECUTE format('REVOKE ALL ON %I.clearance_certificate_verifications FROM PUBLIC, %I, usrp_system_service, usrp_vetting_service', s, officer);
    EXECUTE format('GRANT SELECT ON %I.clearance_certificate_verifications TO %I, usrp_system_service', s, officer);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO usrp_clearance_owner, usrp_vetting_service', s);
    EXECUTE format('GRANT SELECT, INSERT ON %I.clearance_certificate_verifications TO usrp_clearance_owner', s);
    EXECUTE format('GRANT SELECT (id) ON %I.applications TO usrp_clearance_owner', s);

    -- ── FORCE RLS: reads for the officer role and the system service only ──
    EXECUTE format('ALTER TABLE %I.clearance_certificate_verifications ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.clearance_certificate_verifications FORCE ROW LEVEL SECURITY', s);
    EXECUTE format('DROP POLICY IF EXISTS %s_clearance_verif_officer_read ON %I.clearance_certificate_verifications', a, s);
    EXECUTE format('CREATE POLICY %s_clearance_verif_officer_read ON %I.clearance_certificate_verifications FOR SELECT TO %I USING (true)', a, s, officer);
    EXECUTE format('DROP POLICY IF EXISTS %s_clearance_verif_system_read ON %I.clearance_certificate_verifications', a, s);
    EXECUTE format('CREATE POLICY %s_clearance_verif_system_read ON %I.clearance_certificate_verifications FOR SELECT TO usrp_system_service USING (true)', a, s);

    -- ── append-only (every role incl. the owner) ────────────────
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.reject_clearance_verification_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        RAISE EXCEPTION 'clearance_certificate_verifications is append-only: the operation is not permitted on verification evidence'
          USING ERRCODE = 'insufficient_privilege';
      END
      $body$;
    $f$, s);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_clearance_verif_no_update ON %I.clearance_certificate_verifications', s);
    EXECUTE format('CREATE TRIGGER trg_clearance_verif_no_update BEFORE UPDATE ON %I.clearance_certificate_verifications FOR EACH ROW EXECUTE FUNCTION %I.reject_clearance_verification_mutation()', s, s);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_clearance_verif_no_delete ON %I.clearance_certificate_verifications', s);
    EXECUTE format('CREATE TRIGGER trg_clearance_verif_no_delete BEFORE DELETE ON %I.clearance_certificate_verifications FOR EACH ROW EXECUTE FUNCTION %I.reject_clearance_verification_mutation()', s, s);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_clearance_verif_no_truncate ON %I.clearance_certificate_verifications', s);
    EXECUTE format('CREATE TRIGGER trg_clearance_verif_no_truncate BEFORE TRUNCATE ON %I.clearance_certificate_verifications FOR EACH STATEMENT EXECUTE FUNCTION %I.reject_clearance_verification_mutation()', s, s);

    -- ── binding guard: only the four field names, only the five results ──
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.guard_clearance_verification()
      RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_entry record;
      BEGIN
        IF NEW.binding IS NULL THEN
          RETURN NEW;
        END IF;
        IF jsonb_typeof(NEW.binding) <> 'object' THEN
          RAISE EXCEPTION 'clearance verification: binding must be an object' USING ERRCODE = 'check_violation';
        END IF;
        FOR v_entry IN SELECT key, value, jsonb_typeof(value) AS kind FROM jsonb_each(NEW.binding) LOOP
          IF v_entry.key NOT IN ('name', 'dateOfBirth', 'sex', 'nationalIdHint')
             OR v_entry.kind <> 'string'
             OR (v_entry.value #>> '{}') NOT IN ('MATCH', 'PARTIAL', 'MISMATCH', 'NOT_COMPARED', 'UNREADABLE') THEN
            RAISE EXCEPTION 'clearance verification: binding carries only per-field results, never values'
              USING ERRCODE = 'check_violation';
          END IF;
        END LOOP;
        RETURN NEW;
      END
      $body$;
    $f$, s);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_clearance_verif_guard ON %I.clearance_certificate_verifications', s);
    EXECUTE format('CREATE TRIGGER trg_clearance_verif_guard BEFORE INSERT ON %I.clearance_certificate_verifications FOR EACH ROW EXECUTE FUNCTION %I.guard_clearance_verification()', s, s);

    -- ── the write boundary ──────────────────────────────────────
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.record_clearance_verification(
        p_application_id uuid,
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
        IF NOT EXISTS (SELECT 1 FROM %1$I.applications AS app WHERE app.id = p_application_id) THEN
          RETURN jsonb_build_object('outcome', 'REFUSED', 'reason', 'UNKNOWN_APPLICATION');
        END IF;

        -- Idempotent: a redelivered event that concludes the same thing records once.
        SELECT v.reference_hmac, v.certificate_type, v.issued_on, v.outcome, v.failure_code, v.review_reasons
          INTO v_last
        FROM %1$I.clearance_certificate_verifications AS v
        WHERE v.application_id = p_application_id
        ORDER BY v.verified_at DESC, v.id DESC
        LIMIT 1;
        IF FOUND
           AND v_last.reference_hmac = p_reference_hmac
           AND v_last.certificate_type IS NOT DISTINCT FROM p_certificate_type
           AND v_last.issued_on IS NOT DISTINCT FROM p_issued_on
           AND v_last.outcome = p_outcome
           AND v_last.failure_code IS NOT DISTINCT FROM p_failure_code
           AND v_last.review_reasons = v_reasons THEN
          RETURN jsonb_build_object('outcome', 'ALREADY_RECORDED');
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
    EXECUTE format('ALTER FUNCTION %I.record_clearance_verification(uuid, text, text, text, date, text, text, text[], jsonb, text, text) OWNER TO usrp_clearance_owner', s);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.record_clearance_verification(uuid, text, text, text, date, text, text, text[], jsonb, text, text) FROM PUBLIC', s);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.record_clearance_verification(uuid, text, text, text, date, text, text, text[], jsonb, text, text) TO usrp_vetting_service', s);
  END LOOP;
END $$;

COMMIT;
