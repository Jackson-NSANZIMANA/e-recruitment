-- ══════════════════════════════════════════════════════════════════
-- 0034 — Biometric identity evidence (ADR-037)
--
-- Biometrics are identity EVIDENCE, never a verdict. The tablet matches the
-- live face against the portrait printed on the candidate's card ON THE
-- DEVICE and sends a signed, PII-free record (scores, model, policy,
-- outcome). Nothing biometric is ever stored: every column below is a bounded
-- scalar with a CHECK, so not even a bypassing writer can store a blob.
--
-- 1. <agency>_ops.biometric_evidence — append-only (trigger, also for the
--    table owner), FORCE RLS. Written ONLY through
--    <agency>_ops.record_biometric_evidence(…), SECURITY DEFINER, owned by the
--    NOLOGIN BYPASSRLS usrp_biometric_evidence_owner, EXECUTE for the NOLOGIN
--    usrp_biometric_service alone. The function re-checks, in the engine:
--      • the session login is usrp_app and the active role usrp_biometric_service;
--      • the transaction-local usrp.biometric_actor_id equals the officer;
--      • the officer is an ACTIVE screening_officer of THIS agency;
--      • the device exists, is of THIS agency, is not revoked, and the record's
--        key id is the SHA-256 of its stored SPKI public key;
--      • the application exists in THIS agency and the ticket id is the one in
--        the exam QR stored on it (rls/0031);
--      • the record id was never used (same digest+signature = idempotent
--        ALREADY_RECORDED; anything else = REPLAY_CONFLICT).
--    The Ed25519 signature itself is verified by biometric-service (the engine
--    has no Ed25519 primitive). As in rls/0027/0033, the transaction-local
--    actor guards against substitution; the authenticated service remains the
--    trust boundary for WHO (usrp_app is shared, rls/0001).
--
--    Officer read: the agency's officer role may SELECT rows whose mode is NOT
--    SHADOW. SHADOW rows are invisible to every officer — on the detail read
--    AND inside the gate admission transaction, which therefore cannot be
--    influenced by them. No other role has a policy (the blanket grants of
--    rls/0001 are re-applied on every bootstrap; RLS and the triggers are what
--    hold).
--
-- 2. <agency>_ops.gate_manual_identity_confirmations — a field supervisor's
--    confirmation after NO_MATCH / INCONCLUSIVE evidence. Append-only, FORCE
--    RLS, one per evidence row, closed reason codes only. INSERT by the
--    agency's officer role, guarded by a trigger: the evidence must be
--    ADVISORY (visible), NO_MATCH or INCONCLUSIVE, of the same application and
--    ticket, and the supervisor must not be the officer who captured it.
--
-- 3. gate_admissions.identity_method gains NATIONAL_ID_CARD+CARD_PORTRAIT and
--    NATIONAL_ID_CARD+SUPERVISOR; gate_admission_attempts.outcome gains
--    MANUAL_IDENTITY_REQUIRED (ADR-034 check 10).
--
-- 4. Outbox: usrp_biometric_service may stage (never read) its own
--    AUDIT_ENTRY / BIOMETRIC_VERIFICATION_COMPLETED rows as producer
--    biometric-service; the existing system relay drains them.
--
-- Run as usrp_admin AFTER db:migrate, 0001, 0009, 0010, 0020, 0023, 0027,
-- 0031, 0032, 0033. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

-- ── Roles ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usrp_biometric_service') THEN
    CREATE ROLE usrp_biometric_service NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usrp_biometric_evidence_owner') THEN
    CREATE ROLE usrp_biometric_evidence_owner NOLOGIN BYPASSRLS;
  END IF;
END$$;
ALTER ROLE usrp_biometric_service
  WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOLOGIN NOBYPASSRLS;
ALTER ROLE usrp_biometric_evidence_owner
  WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN BYPASSRLS;

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
    WHERE granted.rolname = 'usrp_biometric_evidence_owner'
       OR member.rolname = 'usrp_biometric_evidence_owner'
  LOOP
    EXECUTE format('REVOKE %I FROM %I', v_membership.granted_role, v_membership.member_role);
  END LOOP;
END$$;

-- The shared backend login assumes the service role (like every service role).
GRANT usrp_biometric_service TO usrp_app;

GRANT USAGE ON SCHEMA public_core TO usrp_biometric_service, usrp_biometric_evidence_owner;

-- ── Device registry: read the key, detect the wrong agency ────────
GRANT SELECT (device_id, public_key_pem, agency, revoked_at)
  ON public_core.field_devices TO usrp_biometric_service, usrp_biometric_evidence_owner;
DROP POLICY IF EXISTS pc_fd_biometric ON public_core.field_devices;
CREATE POLICY pc_fd_biometric ON public_core.field_devices
  FOR SELECT TO usrp_biometric_service USING (true);

-- ── Officer liveness for the engine-side actor check ──────────────
GRANT SELECT (officer_id, agency, roles, status)
  ON public_core.officer_accounts TO usrp_biometric_evidence_owner;

-- ── Outbox lane: stage only, own producer, two event types ────────
GRANT INSERT ON public_core.event_outbox TO usrp_biometric_service;
GRANT USAGE ON SEQUENCE public_core.event_outbox_id_seq TO usrp_biometric_service;
DROP POLICY IF EXISTS pc_event_outbox_biometric_stage ON public_core.event_outbox;
CREATE POLICY pc_event_outbox_biometric_stage ON public_core.event_outbox
  FOR INSERT TO usrp_biometric_service
  WITH CHECK (
    producer = 'biometric-service'
    AND event_type IN ('AUDIT_ENTRY', 'BIOMETRIC_VERIFICATION_COMPLETED')
    AND payload->>'eventType' = event_type
  );

-- ── Per agency ────────────────────────────────────────────────────
DO $$
DECLARE
  s text;
  a text;
  officer text;
  tbl text;
BEGIN
  FOREACH s IN ARRAY ARRAY['rdf_ops', 'rnp_ops', 'rcs_ops'] LOOP
    a := split_part(s, '_', 1);
    officer := format('usrp_%s_officer', a);

    -- ── 1. evidence ─────────────────────────────────────────────
    EXECUTE format($t$
      CREATE TABLE IF NOT EXISTS %1$I.biometric_evidence (
        id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        record_id                 uuid NOT NULL,
        application_id            uuid NOT NULL REFERENCES %1$I.applications (id),
        ticket_id                 varchar(64) NOT NULL,
        reference_source          varchar(16) NOT NULL,
        method                    varchar(24) NOT NULL,
        consent_state             varchar(24) NOT NULL,
        outcome                   varchar(16) NOT NULL,
        not_attempted_reason      varchar(32),
        liveness_score_bp         integer,
        match_score_bp            integer,
        model_id                  varchar(64),
        model_version             varchar(32),
        threshold_policy_version  varchar(32) NOT NULL,
        mode                      varchar(16) NOT NULL,
        device_id                 varchar(64) NOT NULL,
        key_id                    char(64) NOT NULL,
        record_digest             char(64) NOT NULL,
        signature                 varchar(88) NOT NULL,
        officer_id                uuid NOT NULL,
        captured_at               timestamptz NOT NULL,
        received_at               timestamptz NOT NULL DEFAULT now(),
        correlation_id            varchar(128),
        CONSTRAINT biometric_evidence_ticket_check CHECK (ticket_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
        CONSTRAINT biometric_evidence_source_check CHECK (reference_source IN ('CARD_PORTRAIT', 'NONE')),
        CONSTRAINT biometric_evidence_method_check CHECK (method IN ('FACE_1_1_ON_DEVICE', 'NONE')),
        CONSTRAINT biometric_evidence_consent_check CHECK (consent_state IN ('GIVEN', 'DECLINED')),
        CONSTRAINT biometric_evidence_outcome_check CHECK (outcome IN ('MATCH', 'NO_MATCH', 'INCONCLUSIVE', 'NOT_ATTEMPTED')),
        CONSTRAINT biometric_evidence_reason_check CHECK (
          (outcome = 'NOT_ATTEMPTED' AND not_attempted_reason IN (
             'CANDIDATE_DECLINED', 'CAPTURE_FAILED', 'CARD_PORTRAIT_UNREADABLE',
             'DEVICE_UNAVAILABLE', 'NO_REFERENCE_SOURCE'))
          OR (outcome <> 'NOT_ATTEMPTED' AND not_attempted_reason IS NULL)),
        CONSTRAINT biometric_evidence_scores_check CHECK (
          (outcome = 'NOT_ATTEMPTED' AND liveness_score_bp IS NULL AND match_score_bp IS NULL
             AND model_id IS NULL AND model_version IS NULL)
          OR (outcome <> 'NOT_ATTEMPTED'
             AND liveness_score_bp BETWEEN 0 AND 10000 AND match_score_bp BETWEEN 0 AND 10000
             AND model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
             AND model_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$')),
        CONSTRAINT biometric_evidence_policy_check CHECK (threshold_policy_version ~ '^[A-Z][A-Za-z0-9._-]{0,31}$'),
        CONSTRAINT biometric_evidence_mode_check CHECK (mode IN ('SHADOW', 'ADVISORY')),
        CONSTRAINT biometric_evidence_device_check CHECK (device_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
        CONSTRAINT biometric_evidence_key_check CHECK (key_id ~ '^[0-9a-f]{64}$'),
        CONSTRAINT biometric_evidence_digest_check CHECK (record_digest ~ '^[0-9a-f]{64}$'),
        CONSTRAINT biometric_evidence_signature_check CHECK (signature ~ '^[A-Za-z0-9+/]{86}==$'),
        CONSTRAINT biometric_evidence_correlation_check CHECK (
          correlation_id IS NULL OR correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$')
      )
    $t$, s);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS idx_%s_biometric_evidence_record ON %I.biometric_evidence (record_id)', a, s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_biometric_evidence_application ON %I.biometric_evidence (application_id, received_at)', a, s);

    -- ── 2. supervised manual identity ───────────────────────────
    EXECUTE format($t$
      CREATE TABLE IF NOT EXISTS %1$I.gate_manual_identity_confirmations (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        evidence_id      uuid NOT NULL REFERENCES %1$I.biometric_evidence (id),
        application_id   uuid NOT NULL REFERENCES %1$I.applications (id),
        ticket_id        varchar(64) NOT NULL,
        reason_code      varchar(48) NOT NULL,
        confirmed_by_id  uuid NOT NULL,
        confirmed_at     timestamptz NOT NULL DEFAULT now(),
        correlation_id   varchar(128),
        CONSTRAINT gate_manual_identity_reason_check CHECK (reason_code IN (
          'CARD_PHOTO_OUTDATED', 'APPEARANCE_CHANGED', 'POOR_CAPTURE_CONDITIONS',
          'CARD_PORTRAIT_DAMAGED', 'SECONDARY_DOCUMENT_CHECKED', 'SUPERVISOR_INTERVIEW')),
        CONSTRAINT gate_manual_identity_correlation_check CHECK (
          correlation_id IS NULL OR correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$')
      )
    $t$, s);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS idx_%s_gate_manual_identity_evidence ON %I.gate_manual_identity_confirmations (evidence_id)', a, s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_gate_manual_identity_application ON %I.gate_manual_identity_confirmations (application_id)', a, s);

    -- ── grants ──────────────────────────────────────────────────
    EXECUTE format('REVOKE ALL ON %I.biometric_evidence FROM PUBLIC, %I, usrp_system_service, usrp_biometric_service', s, officer);
    EXECUTE format('GRANT SELECT ON %I.biometric_evidence TO %I', s, officer);
    EXECUTE format('REVOKE ALL ON %I.gate_manual_identity_confirmations FROM PUBLIC, %I, usrp_system_service, usrp_biometric_service', s, officer);
    EXECUTE format('GRANT SELECT, INSERT ON %I.gate_manual_identity_confirmations TO %I', s, officer);

    EXECUTE format('GRANT USAGE ON SCHEMA %I TO usrp_biometric_evidence_owner', s);
    EXECUTE format('GRANT CREATE ON SCHEMA %I TO usrp_biometric_evidence_owner', s);
    EXECUTE format('GRANT SELECT, INSERT ON %I.biometric_evidence TO usrp_biometric_evidence_owner', s);
    EXECUTE format('GRANT SELECT (id, applicant_id, qr_signed_token) ON %I.applications TO usrp_biometric_evidence_owner', s);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO usrp_biometric_service', s);

    -- ── FORCE RLS ───────────────────────────────────────────────
    FOREACH tbl IN ARRAY ARRAY['biometric_evidence', 'gate_manual_identity_confirmations'] LOOP
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', s, tbl);
      EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', s, tbl);
    END LOOP;
    -- Officers see ADVISORY evidence only. SHADOW is never shown and never used.
    EXECUTE format('DROP POLICY IF EXISTS %s_bio_evidence_officer_read ON %I.biometric_evidence', a, s);
    EXECUTE format($p$CREATE POLICY %s_bio_evidence_officer_read ON %I.biometric_evidence
      FOR SELECT TO %I USING (mode <> 'SHADOW')$p$, a, s, officer);
    EXECUTE format('DROP POLICY IF EXISTS %s_manual_identity_officer_read ON %I.gate_manual_identity_confirmations', a, s);
    EXECUTE format('CREATE POLICY %s_manual_identity_officer_read ON %I.gate_manual_identity_confirmations FOR SELECT TO %I USING (true)', a, s, officer);
    EXECUTE format('DROP POLICY IF EXISTS %s_manual_identity_officer_insert ON %I.gate_manual_identity_confirmations', a, s);
    EXECUTE format('CREATE POLICY %s_manual_identity_officer_insert ON %I.gate_manual_identity_confirmations FOR INSERT TO %I WITH CHECK (true)', a, s, officer);

    -- ── append-only (both tables, every role incl. the owner) ───
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.reject_biometric_record_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        RAISE EXCEPTION '%%.%% is append-only: %% is not permitted on identity evidence',
          TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
      END
      $body$;
    $f$, s);
    FOREACH tbl IN ARRAY ARRAY['biometric_evidence', 'gate_manual_identity_confirmations'] LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_no_update ON %I.%I', tbl, s, tbl);
      EXECUTE format('CREATE TRIGGER trg_%s_no_update BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.reject_biometric_record_mutation()', tbl, s, tbl, s);
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_no_delete ON %I.%I', tbl, s, tbl);
      EXECUTE format('CREATE TRIGGER trg_%s_no_delete BEFORE DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.reject_biometric_record_mutation()', tbl, s, tbl, s);
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_no_truncate ON %I.%I', tbl, s, tbl);
      EXECUTE format('CREATE TRIGGER trg_%s_no_truncate BEFORE TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION %I.reject_biometric_record_mutation()', tbl, s, tbl, s);
    END LOOP;

    -- ── confirmation guard (runs as the inserting role: SHADOW stays invisible) ──
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.guard_manual_identity_confirmation()
      RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_outcome text; v_mode text; v_application uuid; v_ticket text; v_officer uuid;
      BEGIN
        SELECT e.outcome, e.mode, e.application_id, e.ticket_id, e.officer_id
          INTO v_outcome, v_mode, v_application, v_ticket, v_officer
        FROM %1$I.biometric_evidence AS e WHERE e.id = NEW.evidence_id;
        IF NOT FOUND OR v_mode <> 'ADVISORY' THEN
          RAISE EXCEPTION 'manual identity: no such advisory evidence' USING ERRCODE = 'check_violation';
        END IF;
        IF v_outcome NOT IN ('NO_MATCH', 'INCONCLUSIVE') THEN
          RAISE EXCEPTION 'manual identity: evidence outcome %% does not require confirmation', v_outcome
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.application_id IS DISTINCT FROM v_application OR NEW.ticket_id IS DISTINCT FROM v_ticket THEN
          RAISE EXCEPTION 'manual identity: evidence belongs to another application or ticket'
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.confirmed_by_id = v_officer THEN
          RAISE EXCEPTION 'manual identity: the capturing officer cannot confirm their own evidence'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $body$;
    $f$, s);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_manual_identity_guard ON %I.gate_manual_identity_confirmations', s);
    EXECUTE format('CREATE TRIGGER trg_manual_identity_guard BEFORE INSERT ON %I.gate_manual_identity_confirmations FOR EACH ROW EXECUTE FUNCTION %I.guard_manual_identity_confirmation()', s, s);

    -- ── 3. ADR-034 extension ────────────────────────────────────
    EXECUTE format('ALTER TABLE %I.gate_admissions DROP CONSTRAINT IF EXISTS gate_admissions_identity_method_check', s);
    EXECUTE format($c$ALTER TABLE %I.gate_admissions ADD CONSTRAINT gate_admissions_identity_method_check
      CHECK (identity_method IN ('NATIONAL_ID_CARD', 'NATIONAL_ID_CARD+CARD_PORTRAIT', 'NATIONAL_ID_CARD+SUPERVISOR'))$c$, s);
    EXECUTE format('ALTER TABLE %I.gate_admission_attempts DROP CONSTRAINT IF EXISTS gate_admission_attempts_outcome_check', s);
    EXECUTE format($c$ALTER TABLE %I.gate_admission_attempts ADD CONSTRAINT gate_admission_attempts_outcome_check CHECK (outcome IN (
          'ADMITTED', 'ALREADY_ADMITTED', 'MALFORMED_TICKET', 'WRONG_AGENCY',
          'UNKNOWN_TICKET', 'TICKET_NOT_ISSUED', 'NOT_ADMISSIBLE', 'WRONG_VENUE',
          'TOO_EARLY', 'EXPIRED', 'IDENTITY_MISMATCH', 'MANUAL_IDENTITY_REQUIRED'))$c$, s);

    -- ── 1b. the write boundary ──────────────────────────────────
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.record_biometric_evidence(
        p_officer_id uuid,
        p_record_id uuid,
        p_application_id uuid,
        p_ticket_id text,
        p_reference_source text,
        p_method text,
        p_consent_state text,
        p_outcome text,
        p_not_attempted_reason text,
        p_liveness_score_bp integer,
        p_match_score_bp integer,
        p_model_id text,
        p_model_version text,
        p_threshold_policy_version text,
        p_mode text,
        p_device_id text,
        p_key_id text,
        p_record_digest text,
        p_signature text,
        p_captured_at timestamptz,
        p_correlation_id text
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_agency constant text := %2$L;
        v_status text; v_roles text[]; v_officer_agency text;
        v_device_agency text; v_device_pem text; v_device_revoked timestamptz;
        v_key_id text;
        v_token text; v_payload text; v_claims jsonb; v_applicant uuid;
        v_id uuid; v_received timestamptz;
        v_prior record;
      BEGIN
        -- caller: the shared backend login, as the biometric service role
        IF session_user <> 'usrp_app' OR current_setting('role', true) IS DISTINCT FROM 'usrp_biometric_service' THEN
          RAISE EXCEPTION 'biometric evidence requires the biometric-service database role' USING ERRCODE = '42501';
        END IF;
        IF p_officer_id IS NULL
           OR current_setting('usrp.biometric_actor_id', true) IS DISTINCT FROM p_officer_id::text THEN
          RAISE EXCEPTION 'biometric evidence actor does not match transaction actor context' USING ERRCODE = '42501';
        END IF;
        SELECT oa.status, oa.roles, oa.agency::text INTO v_status, v_roles, v_officer_agency
        FROM public_core.officer_accounts AS oa WHERE oa.officer_id = p_officer_id;
        IF NOT FOUND OR v_status <> 'active' OR v_officer_agency IS DISTINCT FROM v_agency
           OR NOT ('screening_officer' = ANY(COALESCE(v_roles, ARRAY[]::text[]))) THEN
          RAISE EXCEPTION 'biometric evidence requires an active screening officer of this agency' USING ERRCODE = '42501';
        END IF;

        -- the device: this agency, not revoked, this key
        SELECT fd.agency::text, fd.public_key_pem, fd.revoked_at
          INTO v_device_agency, v_device_pem, v_device_revoked
        FROM public_core.field_devices AS fd WHERE fd.device_id = p_device_id;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('outcome', 'REFUSED', 'reason', 'UNKNOWN_DEVICE');
        END IF;
        IF v_device_agency IS DISTINCT FROM v_agency THEN
          RETURN jsonb_build_object('outcome', 'REFUSED', 'reason', 'DEVICE_WRONG_AGENCY');
        END IF;
        IF v_device_revoked IS NOT NULL THEN
          RETURN jsonb_build_object('outcome', 'REFUSED', 'reason', 'DEVICE_REVOKED');
        END IF;
        BEGIN
          v_key_id := encode(sha256(decode(
            regexp_replace(v_device_pem, '-----[A-Z ]+-----|[[:space:]]', '', 'g'), 'base64')), 'hex');
        EXCEPTION WHEN OTHERS THEN
          v_key_id := NULL;
        END;
        IF v_key_id IS NULL OR v_key_id IS DISTINCT FROM p_key_id THEN
          RETURN jsonb_build_object('outcome', 'REFUSED', 'reason', 'KEY_MISMATCH');
        END IF;

        -- the ticket: the one in the QR stored on this agency's application
        SELECT app.applicant_id, app.qr_signed_token INTO v_applicant, v_token
        FROM %1$I.applications AS app WHERE app.id = p_application_id;
        IF NOT FOUND OR v_token IS NULL OR split_part(v_token, '.', 1) <> 'USRP-SLOT' THEN
          RETURN jsonb_build_object('outcome', 'REFUSED', 'reason', 'UNKNOWN_TICKET');
        END IF;
        BEGIN
          v_payload := translate(split_part(v_token, '.', 3), '-_', '+/');
          v_payload := v_payload || repeat('=', (4 - length(v_payload) %% 4) %% 4);
          v_claims := convert_from(decode(v_payload, 'base64'), 'UTF8')::jsonb;
        EXCEPTION WHEN OTHERS THEN
          v_claims := NULL;
        END;
        IF v_claims IS NULL
           OR v_claims->>'ticketId' IS DISTINCT FROM p_ticket_id
           OR v_claims->>'applicationId' IS DISTINCT FROM p_application_id::text
           OR v_claims->>'agency' IS DISTINCT FROM v_agency THEN
          RETURN jsonb_build_object('outcome', 'REFUSED', 'reason', 'UNKNOWN_TICKET');
        END IF;

        -- write once; a replayed record id is never a second row
        INSERT INTO %1$I.biometric_evidence (
          record_id, application_id, ticket_id, reference_source, method, consent_state,
          outcome, not_attempted_reason, liveness_score_bp, match_score_bp, model_id,
          model_version, threshold_policy_version, mode, device_id, key_id, record_digest,
          signature, officer_id, captured_at, correlation_id)
        VALUES (
          p_record_id, p_application_id, p_ticket_id, p_reference_source, p_method, p_consent_state,
          p_outcome, p_not_attempted_reason, p_liveness_score_bp, p_match_score_bp, p_model_id,
          p_model_version, p_threshold_policy_version, p_mode, p_device_id, p_key_id, p_record_digest,
          p_signature, p_officer_id, p_captured_at, p_correlation_id)
        ON CONFLICT (record_id) DO NOTHING
        RETURNING id, received_at INTO v_id, v_received;

        IF v_id IS NULL THEN
          SELECT e.id, e.record_digest, e.signature, e.mode, e.received_at INTO v_prior
          FROM %1$I.biometric_evidence AS e WHERE e.record_id = p_record_id;
          IF FOUND AND v_prior.record_digest = p_record_digest AND v_prior.signature = p_signature THEN
            RETURN jsonb_build_object('outcome', 'ALREADY_RECORDED', 'evidenceId', v_prior.id,
              'mode', v_prior.mode, 'receivedAt', v_prior.received_at);
          END IF;
          RETURN jsonb_build_object('outcome', 'REPLAY_CONFLICT');
        END IF;

        RETURN jsonb_build_object('outcome', 'RECORDED', 'evidenceId', v_id,
          'applicantId', v_applicant, 'receivedAt', v_received);
      END
      $body$;
    $f$, s, upper(a));
    EXECUTE format('ALTER FUNCTION %I.record_biometric_evidence(uuid, uuid, uuid, text, text, text, text, text, text, integer, integer, text, text, text, text, text, text, text, text, timestamptz, text) OWNER TO usrp_biometric_evidence_owner', s);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.record_biometric_evidence(uuid, uuid, uuid, text, text, text, text, text, text, integer, integer, text, text, text, text, text, text, text, text, timestamptz, text) FROM PUBLIC', s);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.record_biometric_evidence(uuid, uuid, uuid, text, text, text, text, text, text, integer, integer, text, text, text, text, text, text, text, text, timestamptz, text) TO usrp_biometric_service', s);
  END LOOP;
END $$;

COMMIT;
