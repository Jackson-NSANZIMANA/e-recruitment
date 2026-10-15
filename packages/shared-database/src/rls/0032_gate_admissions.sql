-- ══════════════════════════════════════════════════════════════════
-- 0032 — Single-use admission at the venue gate (BUILD-003, ADR-034)
--
-- The exam QR (ADR-009/033) is a bearer credential valid for the whole exam
-- day. Until now nothing recorded that it had been USED, so a screenshot could
-- be presented at two gates, and the digital lane never left SLOT_ASSIGNED
-- (PHYSICAL_TEST_SCHEDULED needed an SMS delivery that does not exist).
--
-- 1. gate_admissions — ONE row per admitted application, written by the
--    screening officer's own agency role at the gate.
--      • UNIQUE (application_id) and UNIQUE (ticket_id): single use is a
--        database fact, not a code path. Two gates scanning the same QR in the
--        same second serialise on the application row lock, and the loser
--        hits the constraint even if that lock were ever removed.
--      • Immutable: UPDATE / DELETE / TRUNCATE raise (trigger), because the
--        blanket grants of rls/0001 are re-applied on every bootstrap and
--        would otherwise silently re-widen a REVOKE.
--
-- 2. gate_admission_attempts — append-only log of EVERY scan, refused or not
--    (outcome code, gate venue, officer, time). PII-free. It is the evidence
--    for a duplicated screenshot, an impostor, or a mis-routed candidate, and
--    it is written in the same transaction as the decision.
--
-- 3. <agency>_ops.gate_identity_matches(application, hash) — SECURITY DEFINER,
--    EXECUTE for that agency's officer role only. It answers true/false for
--    "does this national-id hash belong to the applicant of this
--    application?" and only for an application in the caller's own agency
--    schema. The comparison happens in the engine, so the stored hash never
--    enters application-service memory on the gate path. The hash of the
--    typed number is computed by identity-service, the sole holder of
--    NATIONAL_ID_HMAC_KEY. (Officer roles can already SELECT their own
--    agency's applicants' identity rows under rls/0001; this function does not
--    widen that, and narrowing it is a separate, pre-existing hardening item.)
--
-- Run as usrp_admin AFTER 0031. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

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

    -- ── 1. admissions ───────────────────────────────────────────
    EXECUTE format($t$
      CREATE TABLE IF NOT EXISTS %1$I.gate_admissions (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id   uuid NOT NULL REFERENCES %1$I.applications (id),
        ticket_id        varchar(64) NOT NULL,
        campaign_id      uuid NOT NULL,
        venue_name       varchar(200) NOT NULL,
        exam_date        date NOT NULL,
        identity_method  varchar(32) NOT NULL,
        admitted_by_id   uuid NOT NULL,
        admitted_at      timestamptz NOT NULL DEFAULT now(),
        correlation_id   varchar(128),
        CONSTRAINT gate_admissions_identity_method_check
          CHECK (identity_method IN ('NATIONAL_ID_CARD'))
      )
    $t$, s);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS idx_%s_gate_admissions_application ON %I.gate_admissions (application_id)', a, s);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS idx_%s_gate_admissions_ticket ON %I.gate_admissions (ticket_id)', a, s);

    -- ── 2. attempts ─────────────────────────────────────────────
    EXECUTE format($t$
      CREATE TABLE IF NOT EXISTS %1$I.gate_admission_attempts (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id   uuid,
        ticket_id        varchar(64),
        outcome          varchar(32) NOT NULL,
        gate_venue_name  varchar(200) NOT NULL,
        officer_id       uuid NOT NULL,
        attempted_at     timestamptz NOT NULL DEFAULT now(),
        correlation_id   varchar(128),
        CONSTRAINT gate_admission_attempts_outcome_check CHECK (outcome IN (
          'ADMITTED', 'ALREADY_ADMITTED', 'MALFORMED_TICKET', 'WRONG_AGENCY',
          'UNKNOWN_TICKET', 'TICKET_NOT_ISSUED', 'NOT_ADMISSIBLE', 'WRONG_VENUE',
          'TOO_EARLY', 'EXPIRED', 'IDENTITY_MISMATCH'))
      )
    $t$, s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_gate_attempts_application ON %I.gate_admission_attempts (application_id)', a, s);

    -- ── grants: officer writes its own agency; system reads ─────
    EXECUTE format('GRANT SELECT, INSERT ON %I.gate_admissions, %I.gate_admission_attempts TO %I', s, s, officer);
    EXECUTE format('GRANT SELECT ON %I.gate_admissions, %I.gate_admission_attempts TO usrp_system_service', s, s);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I.gate_admissions, %I.gate_admission_attempts FROM %I, usrp_system_service', s, s, officer);

    -- ── immutability (both tables) ──────────────────────────────
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.reject_gate_record_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        RAISE EXCEPTION '%%.%% is append-only: %% is not permitted on a gate admission record',
          TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
      END
      $body$;
    $f$, s);
    FOREACH tbl IN ARRAY ARRAY['gate_admissions', 'gate_admission_attempts'] LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_no_update ON %I.%I', tbl, s, tbl);
      EXECUTE format('CREATE TRIGGER trg_%s_no_update BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.reject_gate_record_mutation()', tbl, s, tbl, s);
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_no_delete ON %I.%I', tbl, s, tbl);
      EXECUTE format('CREATE TRIGGER trg_%s_no_delete BEFORE DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.reject_gate_record_mutation()', tbl, s, tbl, s);
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_no_truncate ON %I.%I', tbl, s, tbl);
      EXECUTE format('CREATE TRIGGER trg_%s_no_truncate BEFORE TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION %I.reject_gate_record_mutation()', tbl, s, tbl, s);
    END LOOP;

    -- ── 3. the identity-match oracle, agency-scoped ─────────────
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.gate_identity_matches(p_application_id uuid, p_national_id_hash text)
      RETURNS boolean
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE v_stored text;
      BEGIN
        IF p_application_id IS NULL OR p_national_id_hash IS NULL
           OR p_national_id_hash !~ '^[0-9a-f]{64}$' THEN
          RETURN false;
        END IF;
        SELECT i.national_id_hash INTO v_stored
        FROM %1$I.applications AS app
        JOIN public_core.applicant_identities AS i ON i.id = app.applicant_id
        WHERE app.id = p_application_id AND i.deleted_at IS NULL;
        RETURN v_stored IS NOT NULL AND v_stored = p_national_id_hash;
      END
      $body$;
    $f$, s);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.gate_identity_matches(uuid, text) FROM PUBLIC', s);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.gate_identity_matches(uuid, text) TO %I', s, officer);
  END LOOP;
END $$;

COMMIT;
