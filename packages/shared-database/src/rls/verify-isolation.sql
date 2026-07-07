-- ══════════════════════════════════════════════════════════════════
-- USRP — Cross-Agency Isolation Proof (repeatable regression test)
--
-- Proves the single most important correctness claim in the system:
-- an RDF officer CANNOT see an applicant who only has an RNP application,
-- enforced by FORCE'd RLS at the Postgres engine level — not app logic.
--
-- Run as usrp_admin (owner). It SET ROLEs into each officer role via the
-- same membership usrp_app uses in production. Rolls back at the end, so
-- it leaves no data behind. Exits with an ERROR (non-zero) on any failure.
--
--   docker exec -e PGPASSWORD=usrp_dev_password usrp-postgres \
--     psql -U usrp_admin -d usrp_db -v ON_ERROR_STOP=1 \
--     -f /path/verify-isolation.sql
-- ══════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
BEGIN;

-- ── Seed: two identities, each with an application in ONE agency ──────
-- Encryption via pgcrypto so we exercise the real PII path.
SET app.encryption_key = 'test_isolation_key_do_not_use_in_prod';

INSERT INTO public_core.applicant_identities
  (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
   encrypted_home_district, encrypted_home_province, gender, registration_channel)
VALUES
  ('11111111-1111-1111-1111-111111111111', repeat('a',64),
   pgp_sym_encrypt('RDF Applicant', current_setting('app.encryption_key')),
   pgp_sym_encrypt('2004-01-01', current_setting('app.encryption_key')),
   pgp_sym_encrypt('GASABO', current_setting('app.encryption_key')),
   pgp_sym_encrypt('KIGALI_CITY', current_setting('app.encryption_key')),
   'MALE', 'WEB'),
  ('22222222-2222-2222-2222-222222222222', repeat('b',64),
   pgp_sym_encrypt('RNP Applicant', current_setting('app.encryption_key')),
   pgp_sym_encrypt('2003-05-05', current_setting('app.encryption_key')),
   pgp_sym_encrypt('HUYE', current_setting('app.encryption_key')),
   pgp_sym_encrypt('SOUTHERN_PROVINCE', current_setting('app.encryption_key')),
   'MALE', 'WEB');

-- A campaign per agency (FK target for applications).
INSERT INTO public_core.recruitment_campaigns
  (id, campaign_label, agency, status, target_categories,
   registration_opens_at, registration_closes_at,
   examination_start_date, examination_end_date, examination_reporting_hour)
VALUES
  ('c1111111-1111-1111-1111-111111111111', 'RDF-ISOLATION-TEST', 'RDF', 'REGISTRATION_OPEN',
   '["GENERAL_ENLISTMENT"]', now(), now() + interval '30 days', '2026-09-01', '2026-09-30', 8),
  ('c2222222-2222-2222-2222-222222222222', 'RNP-ISOLATION-TEST', 'RNP', 'REGISTRATION_OPEN',
   '["CADET_OFFICER"]', now(), now() + interval '30 days', '2026-09-01', '2026-09-30', 8);

INSERT INTO rdf_ops.applications
  (id, processing_code, applicant_id, campaign_id, category, status)
VALUES
  ('a1111111-1111-1111-1111-111111111111', 'RDF-TEST-0001',
   '11111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111',
   'GENERAL_ENLISTMENT', 'SUBMITTED');

INSERT INTO rnp_ops.applications
  (id, processing_code, applicant_id, campaign_id, category, status)
VALUES
  ('a2222222-2222-2222-2222-222222222222', 'RNP-TEST-0001',
   '22222222-2222-2222-2222-222222222222', 'c2222222-2222-2222-2222-222222222222',
   'CADET_OFFICER', 'SUBMITTED');

-- ── Assertions as RDF officer ────────────────────────────────────────
SET ROLE usrp_rdf_officer;

DO $$
DECLARE rdf_visible int; rnp_visible int;
BEGIN
  SELECT count(*) INTO rdf_visible FROM public_core.applicant_identities
    WHERE id = '11111111-1111-1111-1111-111111111111';
  SELECT count(*) INTO rnp_visible FROM public_core.applicant_identities
    WHERE id = '22222222-2222-2222-2222-222222222222';

  IF rdf_visible <> 1 THEN
    RAISE EXCEPTION 'FAIL: RDF officer cannot see its OWN applicant (got %)', rdf_visible;
  END IF;
  IF rnp_visible <> 0 THEN
    RAISE EXCEPTION 'LEAK: RDF officer can see an RNP-only applicant (got %)', rnp_visible;
  END IF;
  RAISE NOTICE 'PASS: RDF officer sees own applicant (1), RNP applicant hidden (0)';
END $$;

-- RDF officer must not even be able to read the rnp_ops schema.
DO $$
BEGIN
  PERFORM count(*) FROM rnp_ops.applications;
  RAISE EXCEPTION 'LEAK: RDF officer could query rnp_ops.applications';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: RDF officer denied access to rnp_ops.applications (insufficient_privilege)';
END $$;

RESET ROLE;

-- ── Assertions as RNP officer (mirror) ───────────────────────────────
SET ROLE usrp_rnp_officer;

DO $$
DECLARE rnp_visible int; rdf_visible int;
BEGIN
  SELECT count(*) INTO rnp_visible FROM public_core.applicant_identities
    WHERE id = '22222222-2222-2222-2222-222222222222';
  SELECT count(*) INTO rdf_visible FROM public_core.applicant_identities
    WHERE id = '11111111-1111-1111-1111-111111111111';

  IF rnp_visible <> 1 THEN
    RAISE EXCEPTION 'FAIL: RNP officer cannot see its OWN applicant (got %)', rnp_visible;
  END IF;
  IF rdf_visible <> 0 THEN
    RAISE EXCEPTION 'LEAK: RNP officer can see an RDF-only applicant (got %)', rdf_visible;
  END IF;
  RAISE NOTICE 'PASS: RNP officer sees own applicant (1), RDF applicant hidden (0)';
END $$;

RESET ROLE;

-- ── System service sees BOTH (runs cross-agency vetting) ─────────────
SET ROLE usrp_system_service;
DO $$
DECLARE total int;
BEGIN
  SELECT count(*) INTO total FROM public_core.applicant_identities
    WHERE id IN ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222');
  IF total <> 2 THEN
    RAISE EXCEPTION 'FAIL: system service must see both applicants (got %)', total;
  END IF;
  RAISE NOTICE 'PASS: system service sees both applicants (2)';
END $$;
RESET ROLE;

\echo '───────────────────────────────────────────────'
\echo 'ALL ISOLATION ASSERTIONS PASSED'

-- Leave no trace.
ROLLBACK;
