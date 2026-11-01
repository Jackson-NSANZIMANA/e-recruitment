-- ══════════════════════════════════════════════════════════════════
-- 0046 — Document supersession and the review lock · D0 (Phase 0), ADR-052
--
-- THE DEFECT THIS CLOSES (evaluation 2026-10-29, D8). The document door keeps
-- ONE object per (agency, application, document type) under a derived, stable
-- key (domain/object-key.ts) — a deliberate PII-minimisation choice. The side
-- effect was that a second upload of the same type became an UPDATE: the same
-- documentId, no revision, no digest, and crucially `human_reviewed_by_id` was
-- left untouched. So a citizen could upload a certificate, have an officer
-- review it CLEAR, and then replace the bytes: the row kept the approval stamp
-- while the file behind it changed. Evidence tampering with the platform's own
-- stamp on it, and "which bytes did the officer approve?" was unanswerable.
--
-- THE FIX, in two parts:
--
--   1. `document_records` gains `revision` and `content_hmac`. The KEYED digest
--      (HMAC, never a bare hash — a SHA-256 of a national ID is a confirmation
--      oracle for anyone holding a candidate document) is what lets a retried
--      upload of identical bytes be recognised as ONE revision instead of two.
--
--   2. `document_revisions` is the append-only trail of what passed through the
--      slot: one row per upload, never updated, never deleted. `document_records`
--      stays the LIVE slot; the trail answers what a reviewer, an appeal or a
--      court will ask.
--
-- The review lock itself (409 DOCUMENT_REVIEW_CLOSED) is app logic in
-- document-record.pg-store.ts, inside the same FOR UPDATE transaction that
-- claims the slot: a status at or below DOCUMENT_REVIEW_AMBER (canonical
-- APPLICATION_STATUSES rank) AND a slot with no human_reviewed_at. A database
-- CHECK cannot express "compare against an ordered enum", and duplicating the
-- order in SQL is exactly the drift this programme keeps deleting.
--
-- All three agencies, one migration: an agency-specific table is the D1 class
-- of defect, and verify-cross-agency-columns.ts asserts the shape is identical.
--
-- Number: 0046 (renumbered from 0044 at rebase onto rls/0043-0044), reserved for ADR-052 in the programme README. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

DO $$
DECLARE
  schema_name text;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['rdf_ops', 'rnp_ops', 'rcs_ops']
  LOOP
    -- ── The live slot gains a revision counter and a keyed digest ──
    EXECUTE format(
      'ALTER TABLE %I.document_records
         ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1,
         ADD COLUMN IF NOT EXISTS content_hmac varchar(64)', schema_name);

    EXECUTE format(
      'ALTER TABLE %I.document_records DROP CONSTRAINT IF EXISTS %I', schema_name,
      schema_name || '_document_revision_positive');
    EXECUTE format(
      'ALTER TABLE %I.document_records ADD CONSTRAINT %I CHECK (revision >= 1)',
      schema_name, schema_name || '_document_revision_positive');

    -- ── The append-only trail ──────────────────────────────────────
    EXECUTE format($f$
      CREATE TABLE IF NOT EXISTS %I.document_revisions (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id         uuid NOT NULL REFERENCES %I.document_records(id),
        application_id      uuid NOT NULL REFERENCES %I.applications(id),
        revision            integer NOT NULL CHECK (revision >= 1),
        content_hmac        varchar(64) NOT NULL,
        file_size_bytes     integer NOT NULL,
        mime_type           varchar(255) NOT NULL,
        forensics_lane      %I.document_lane NOT NULL,
        forensics_score     numeric(5,2),
        forensics_flags     jsonb NOT NULL DEFAULT '{}'::jsonb,
        uploaded_by         varchar(32) NOT NULL DEFAULT 'APPLICANT',
        uploaded_at         timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT %I UNIQUE (document_id, revision)
      )$f$, schema_name, schema_name, schema_name, schema_name, schema_name,
      schema_name || '_document_revisions_slot_revision_key');

    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.document_revisions (application_id, uploaded_at DESC)',
      'idx_' || schema_name || '_document_revisions_app', schema_name);

    -- APPEND-ONLY, two independent guards (the rls/0002/0007 idiom):
    --   belt      — strip UPDATE/DELETE/TRUNCATE from the writing role;
    --   suspenders — a trigger that RAISEs for every role, owner and superuser.
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I.document_revisions FROM usrp_system_service', schema_name);
    EXECUTE format('GRANT SELECT, INSERT ON %I.document_revisions TO usrp_system_service', schema_name);

    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %I.reject_document_revision_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        RAISE EXCEPTION
          '%I.document_revisions is append-only: %% is not permitted on the revision trail (ADR-052)',
          TG_OP USING ERRCODE = 'insufficient_privilege';
      END;
      $body$
      $f$, schema_name, schema_name);

    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_revisions_no_update ON %I.document_revisions',
      schema_name, schema_name);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_revisions_no_update BEFORE UPDATE ON %I.document_revisions
         FOR EACH ROW EXECUTE FUNCTION %I.reject_document_revision_mutation()',
      schema_name, schema_name, schema_name);

    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_revisions_no_delete ON %I.document_revisions',
      schema_name, schema_name);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_revisions_no_delete BEFORE DELETE ON %I.document_revisions
         FOR EACH ROW EXECUTE FUNCTION %I.reject_document_revision_mutation()',
      schema_name, schema_name, schema_name);

    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_revisions_no_truncate ON %I.document_revisions',
      schema_name, schema_name);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_revisions_no_truncate BEFORE TRUNCATE ON %I.document_revisions
         FOR EACH STATEMENT EXECUTE FUNCTION %I.reject_document_revision_mutation()',
      schema_name, schema_name, schema_name);
  END LOOP;
END
$$;

COMMIT;
