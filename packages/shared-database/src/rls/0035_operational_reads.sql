-- ══════════════════════════════════════════════════════════════════
-- 0035 — Operational read models: indexes only (ADR-039)
--
-- S04 adds agency-scoped reads (admin campaign list/detail, the officer
-- application search with a keyset cursor and totals, the venue roster). Every
-- one runs under the officer's OWN agency role against tables that role can
-- already SELECT under FORCE'd RLS (rls/0001, 0026, 0032). THIS FILE GRANTS
-- NOTHING and creates no table, view, function or policy: it only adds the
-- indexes those reads sort and filter on.
--
--   <agency>_ops.applications   keyset  (COALESCE(submitted_at, created_at) DESC, id DESC)
--                               roster  (campaign_id, assigned_district)
--                               filter  (status)
--   public_core.recruitment_campaigns  keyset (agency, created_at DESC, id DESC)
--
-- Run as usrp_admin AFTER 0033. Fully re-runnable (IF NOT EXISTS).
-- ══════════════════════════════════════════════════════════════════
BEGIN;

DO $$
DECLARE
  s text;
  a text;
BEGIN
  FOREACH s IN ARRAY ARRAY['rdf_ops', 'rnp_ops', 'rcs_ops'] LOOP
    a := split_part(s, '_', 1);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%s_applications_read_keyset ON %I.applications ((COALESCE(submitted_at, created_at)) DESC, id DESC)',
      a, s);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%s_applications_roster ON %I.applications (campaign_id, assigned_district) WHERE assigned_district IS NOT NULL',
      a, s);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%s_applications_read_status ON %I.applications (status)',
      a, s);
  END LOOP;
END$$;

CREATE INDEX IF NOT EXISTS idx_pc_campaigns_read_keyset
  ON public_core.recruitment_campaigns (agency, created_at DESC, id DESC);

COMMIT;
