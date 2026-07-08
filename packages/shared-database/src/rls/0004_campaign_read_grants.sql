-- ══════════════════════════════════════════════════════════════════
-- 0004 — Campaign read grants (front door)
--
-- The front door (application-service) resolves the OPEN campaign a
-- submission attaches to server-side: the applicant picks agency+category,
-- never a campaign UUID, so the service reads public_core.recruitment_
-- campaigns to find the REGISTRATION_OPEN campaign whose window contains
-- now() and whose target_categories include the chosen category.
--
-- It performs that read as usrp_system_service, which — unlike
-- applicant_identities — had NO grant on recruitment_campaigns (0001
-- covered only the identities table in public_core). Without this the front
-- door fails closed with "permission denied for table recruitment_campaigns".
--
-- recruitment_campaigns carries no citizen PII — it is agency-scoped
-- reference data (label, window, target categories, exam dates), row-scoped
-- by its `agency` column, not by RLS (it has none). So a plain SELECT grant
-- is the right, minimal fix; no policy is needed. Read-only: the front door
-- never writes campaigns (campaign authoring is a separate, admin concern).
--
-- Run as usrp_admin AFTER db:migrate and 0001. Fully re-runnable — GRANT is
-- idempotent.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

-- The system service reads campaigns for every agency (it owns the front
-- door's write path across all three), so it reads the shared campaign table.
GRANT SELECT ON public_core.recruitment_campaigns TO usrp_system_service;

COMMIT;
