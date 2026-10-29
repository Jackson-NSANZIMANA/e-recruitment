-- ══════════════════════════════════════════════════════════════════
-- 0041 — Campaign policy v2 guard · S12c, ADR-049
--
-- A v2 policy is an ADDITIVE `v2` block inside a category's policy document
-- (policy_document -> <CATEGORY> -> 'v2'). The application-service validates
-- it (packages/shared-campaign-policy) before the command function stores it.
-- This constraint is the database-level guard behind that validation, so a
-- write that bypasses the service still cannot store a block a v2 reader would
-- misread: every `v2` block must say schemaVersion 2, carry the six rule
-- fields, and name a closed conviction rule.
--
-- No new table, column, grant or hash change: policy_hash and hash_version stay
-- as in rls/0027 (the hash covers the whole document, v2 block included, so a
-- published v2 policy is as immutable and hash-bound as a v1 one, ADR-030).
-- v1 documents (no `v2` key anywhere) satisfy the constraint trivially.
--
-- Number: 0041, reserved for S12c in the README table. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION public_core.policy_document_v2_wellformed(p_document jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM jsonb_each(p_document) AS category(name, policy)
    WHERE jsonb_typeof(category.policy) = 'object'
      AND category.policy ? 'v2'
      AND NOT (
        jsonb_typeof(category.policy -> 'v2') = 'object'
        AND (category.policy -> 'v2' ->> 'schemaVersion') = '2'
        AND (category.policy -> 'v2') ?& ARRAY['ageBands', 'educationAlternatives', 'minimumSciencePercent', 'conviction', 'documents', 'clearance']
        AND (category.policy -> 'v2' -> 'conviction' ->> 'rule') IN ('NEVER_CONVICTED', 'NO_SENTENCE_6M_OR_MORE', 'NO_SENTENCE_OVER_6M')
        AND jsonb_typeof(category.policy -> 'v2' -> 'ageBands') = 'array'
        AND jsonb_array_length(category.policy -> 'v2' -> 'ageBands') > 0
      )
  );
$$;

ALTER TABLE public_core.campaign_policy_versions
  DROP CONSTRAINT IF EXISTS campaign_policy_v2_wellformed;
ALTER TABLE public_core.campaign_policy_versions
  ADD CONSTRAINT campaign_policy_v2_wellformed
  CHECK (public_core.policy_document_v2_wellformed(policy_document));

COMMIT;
