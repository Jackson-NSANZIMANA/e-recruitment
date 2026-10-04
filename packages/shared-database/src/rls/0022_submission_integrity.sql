-- ══════════════════════════════════════════════════════════════════
-- 0022 — Submission integrity: business uniqueness (F5) + request ledger
--
-- 1. PRE-FLIGHT. Refuses to run if any agency already holds duplicates.
--    Citizen records are never silently deduplicated.
-- 2. One live application per (applicant, campaign, category) per agency.
--    WITHDRAWN rows do not count (owner decision D1: re-apply after withdrawal
--    is allowed; change the predicate if that decision changes).
-- 3. public_core.submission_requests: the request-idempotency ledger. Written
--    FIRST, in the same transaction as the application + history + outbox, so a
--    retry with the same key replays the stored result, and a concurrent
--    duplicate waits on the PK and then replays instead of filing twice.
--    Append-only for its writer (SELECT + INSERT).
--
-- Run as usrp_admin AFTER 0001/0020/0021. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

DO $$
DECLARE s text; dups bigint;
BEGIN
  FOREACH s IN ARRAY ARRAY['rdf_ops','rnp_ops','rcs_ops'] LOOP
    EXECUTE format(
      'SELECT count(*) FROM (SELECT 1 FROM %I.applications WHERE status <> ''WITHDRAWN''
         GROUP BY applicant_id, campaign_id, category HAVING count(*) > 1) d', s) INTO dups;
    IF dups > 0 THEN
      RAISE EXCEPTION '0022: % duplicate live application group(s) in %. Resolve them by hand before applying.', dups, s;
    END IF;
  END LOOP;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_rdf_applications_live_intent
  ON rdf_ops.applications (applicant_id, campaign_id, category) WHERE status <> 'WITHDRAWN';
CREATE UNIQUE INDEX IF NOT EXISTS uq_rnp_applications_live_intent
  ON rnp_ops.applications (applicant_id, campaign_id, category) WHERE status <> 'WITHDRAWN';
CREATE UNIQUE INDEX IF NOT EXISTS uq_rcs_applications_live_intent
  ON rcs_ops.applications (applicant_id, campaign_id, category) WHERE status <> 'WITHDRAWN';

CREATE TABLE IF NOT EXISTS public_core.submission_requests (
  applicant_id     uuid               NOT NULL,
  idempotency_key  uuid               NOT NULL,
  request_hash     text               NOT NULL,
  agency           public_core.agency NOT NULL,
  application_id   uuid               NOT NULL,
  processing_code  text               NOT NULL,
  created_at       timestamptz        NOT NULL DEFAULT now(),
  PRIMARY KEY (applicant_id, idempotency_key),
  CONSTRAINT submission_requests_application_unique UNIQUE (application_id)
);

GRANT SELECT, INSERT ON public_core.submission_requests TO usrp_system_service;
REVOKE UPDATE, DELETE, TRUNCATE ON public_core.submission_requests FROM usrp_system_service;
ALTER TABLE public_core.submission_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.submission_requests FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pc_submission_requests_system ON public_core.submission_requests;
CREATE POLICY pc_submission_requests_system ON public_core.submission_requests
  TO usrp_system_service USING (true) WITH CHECK (true);

COMMIT;
