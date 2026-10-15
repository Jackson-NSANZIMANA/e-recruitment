-- ══════════════════════════════════════════════════════════════════
-- 0030 — Venue verification of documents + system read of policy versions
--          (ADR-032, owner decisions of 2026-10-14)
--
-- 1. VENUE VERIFICATION. The front-door on-site officer who checks a candidate
--    in may clear a required document by seeing the paper. That is a recorded,
--    attributed fact — not an upload — so it gets its own columns rather than
--    overloading human_review_decision (which belongs to the amber review):
--
--      venue_verified_by_id  the officer (token sub) who saw the document
--      venue_verified_at     when
--
--    A venue row carries no object. Both columns are WRITE-ONCE (trigger).
--    At most ONE venue verification per (application, document type), so a
--    re-scan at the gate is idempotent rather than a second record. The index
--    is `uq_`-named, like 0022's live-intent index: the drift gate compares
--    only `idx_*` indexes, and its predicate is asserted live instead
--    (verify-document-checklist.ts).
--
-- 2. SYSTEM READ OF POLICY VERSIONS. The citizen's own document checklist is
--    computed by application-service as usrp_system_service (the citizen is
--    cross-agency by construction). It needs the bound policy version's
--    requiredDocumentTypes. Officers already read their own agency's versions
--    (0026); the system role is granted SELECT only — no write — with an
--    explicit policy. Nothing from the policy reaches the citizen except the
--    list of document types, which the public announcements already state.
--
-- Run as usrp_admin AFTER 0029. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['rdf_ops', 'rnp_ops', 'rcs_ops'] LOOP
    EXECUTE format(
      'ALTER TABLE %I.document_records
         ADD COLUMN IF NOT EXISTS venue_verified_by_id uuid,
         ADD COLUMN IF NOT EXISTS venue_verified_at timestamptz', s);

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_%s_docs_venue_once
         ON %I.document_records (application_id, document_type)
         WHERE venue_verified_by_id IS NOT NULL', split_part(s, '_', 1), s);

    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.document_venue_verification_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF OLD.venue_verified_by_id IS NOT NULL AND (
             NEW.venue_verified_by_id IS DISTINCT FROM OLD.venue_verified_by_id OR
             NEW.venue_verified_at IS DISTINCT FROM OLD.venue_verified_at) THEN
          RAISE EXCEPTION 'document_records venue verification is immutable once recorded'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END
      $body$;
    $f$, s);

    EXECUTE format('DROP TRIGGER IF EXISTS trg_document_venue_verification_immutable ON %I.document_records', s);
    EXECUTE format(
      'CREATE TRIGGER trg_document_venue_verification_immutable
         BEFORE UPDATE ON %I.document_records
         FOR EACH ROW EXECUTE FUNCTION %I.document_venue_verification_immutable()', s, s);
  END LOOP;
END $$;

GRANT SELECT ON public_core.campaign_policy_versions TO usrp_system_service;
DROP POLICY IF EXISTS pc_policy_versions_system ON public_core.campaign_policy_versions;
CREATE POLICY pc_policy_versions_system ON public_core.campaign_policy_versions
  FOR SELECT TO usrp_system_service USING (true);

COMMIT;
