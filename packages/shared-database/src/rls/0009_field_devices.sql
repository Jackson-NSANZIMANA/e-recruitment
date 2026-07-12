-- ══════════════════════════════════════════════════════════════════
-- 0009 — Field-device registry (offline physical-test score sync, ADR-010)
--
-- Field officers score the physical test on tablets, frequently offline, and
-- sign each score record with a device-held Ed25519 key. For that signature to
-- mean anything, the server must know each device's PUBLIC key and trust it.
-- public_core.field_devices is that registry: one row per enrolled tablet,
-- binding its device_id → public key → owning agency. field-sync-service
-- verifies every uploaded record's device_signature against this table before
-- accepting it (verifyFieldScoreRecord); an unenrolled or revoked device is
-- rejected, never stored. Revocation is a timestamp, not a delete — the trail
-- of what a device was trusted to sign is retained.
--
-- Enrollment/verification run as usrp_system_service (field-sync writes as the
-- system role, like every other service). Officers may READ their own agency's
-- devices — enforced by FORCE'd RLS scoped on the agency column, mirroring
-- applicant_identities so "officer SELECT own-agency" is a real engine
-- guarantee, not just a code convention. An RNP officer never sees RDF devices.
--
-- Run as usrp_admin AFTER db:migrate and 0001. Fully re-runnable
-- (IF NOT EXISTS + idempotent GRANT/POLICY).
-- ══════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS public_core.field_devices (
  device_id       varchar(64)  PRIMARY KEY,
  public_key_pem  text         NOT NULL,
  agency          public_core.agency NOT NULL,
  enrolled_by     varchar(128) NOT NULL,   -- enrolling officer's opaque subject id
  enrolled_at     timestamptz  NOT NULL DEFAULT now(),
  revoked_at      timestamptz             -- NULL = active; set = no longer trusted
);

CREATE INDEX IF NOT EXISTS idx_pc_field_devices_agency
  ON public_core.field_devices (agency);

-- field-sync-service enrolls, reads (for verification), and revokes as the
-- system role. Officers get read-only, RLS-scoped to their agency (below).
GRANT SELECT, INSERT, UPDATE ON public_core.field_devices TO usrp_system_service;
GRANT SELECT ON public_core.field_devices
  TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;

-- FORCE RLS so even the table owner is constrained (mirrors applicant_identities).
ALTER TABLE public_core.field_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.field_devices FORCE  ROW LEVEL SECURITY;

-- System workers verify signatures across agencies → see/write everything.
DROP POLICY IF EXISTS pc_fd_system ON public_core.field_devices;
CREATE POLICY pc_fd_system ON public_core.field_devices
  TO usrp_system_service USING (true) WITH CHECK (true);

-- Each officer sees ONLY their own agency's enrolled devices. The registry
-- carries the agency directly, so the scope is a plain column predicate.
DROP POLICY IF EXISTS pc_fd_rdf ON public_core.field_devices;
CREATE POLICY pc_fd_rdf ON public_core.field_devices
  TO usrp_rdf_officer USING (agency = 'RDF');

DROP POLICY IF EXISTS pc_fd_rnp ON public_core.field_devices;
CREATE POLICY pc_fd_rnp ON public_core.field_devices
  TO usrp_rnp_officer USING (agency = 'RNP');

DROP POLICY IF EXISTS pc_fd_rcs ON public_core.field_devices;
CREATE POLICY pc_fd_rcs ON public_core.field_devices
  TO usrp_rcs_officer USING (agency = 'RCS');

COMMIT;
