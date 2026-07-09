-- ══════════════════════════════════════════════════════════════════
-- 0008 — Venue read grants (slot assignment)
--
-- scheduling-service assigns an exam venue to a cleared application by looking
-- up public_core.campaign_venue_assignments on (campaign_id, district) — the
-- district → venue map seeded from official announcements. It performs that
-- read as usrp_system_service, which had NO grant on this table (0001 covered
-- only applicant_identities in public_core; 0004 added recruitment_campaigns).
-- Without this the assignment fails closed with "permission denied for table
-- campaign_venue_assignments".
--
-- Like recruitment_campaigns, this table carries no citizen PII — it is
-- agency-scoped reference data (district, venue, exam date), not row-scoped by
-- RLS (it has none). A plain SELECT grant is the right, minimal fix. Read-only:
-- scheduling never writes venues (venue authoring is a separate admin/seed
-- concern); it only stamps the chosen venue onto the application via the
-- application-service projection.
--
-- Run as usrp_admin AFTER db:migrate and 0001. Fully re-runnable (GRANT is idempotent).
-- ══════════════════════════════════════════════════════════════════
BEGIN;

GRANT SELECT ON public_core.campaign_venue_assignments TO usrp_system_service;

COMMIT;
