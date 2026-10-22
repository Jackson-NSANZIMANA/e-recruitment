-- ══════════════════════════════════════════════════════════════════
-- 0036 — Device fleet and venue operations (S09; ADR-036 addendum "S09 device management")
--
-- A lost tablet holds an enrolled signing key and, since B1, biometric evidence
-- capability. public_core.field_devices already honours revoked_at on every
-- score sync and every biometric evidence, but nothing could set it and nobody
-- could see the fleet. This file adds, and only adds:
--
--  1. Fleet columns on field_devices: last_seen_at / last_seen_source /
--     last_sync_at (monotonic, stamped only by public_core.touch_field_device on
--     a SIGNED contact), revoked_by / revoke_reason (closed vocabulary — no free
--     text, so the audit stays PII-free).
--  2. A guard trigger: the key and the owning agency never change, and a
--     revocation is final (a revoked device is replaced by a new enrolment, never
--     revived). Rotation is revoke + enrol under a new device id.
--  3. public_core.touch_field_device(device, source): the ONLY writer of the
--     last-seen columns for biometric-service (SECURITY DEFINER, owned by the
--     NOLOGIN usrp_device_fleet_owner, column grants only). EXECUTE:
--     usrp_biometric_service and usrp_system_service (field-sync).
--  4. public_core.field_device_assignments: a device is bound to ONE venue day
--     (campaign + district + exam date). Written by field-sync (system role),
--     read by the officer's own agency through FORCE'd RLS.
--  5. public_core.venue_day_counts: the live per-venue/day projection
--     (expected, admitted, physical captured, medical recorded, open conflicts,
--     as_of). Maintained in the SAME transaction as each event it projects — a
--     gate admission, a physical-score write or conflict flag, an application
--     entering or leaving the venue's roster — by SECURITY DEFINER trigger
--     functions owned by the NOLOGIN usrp_venue_projection_owner. Every refresh
--     RECOMPUTES the five counts for that venue day (never increments), so the
--     projection cannot drift and a replayed event is harmless. Officers read
--     their own agency's rows only; nobody can write the table directly.
--
-- Residual: the projection is refreshed on INSERT/UPDATE of its sources, not on DELETE
-- (applications and scores are never deleted; erasure tombstones) nor on edits to
-- campaign_venue_assignments; each refresh is a full recount per venue day, which is
-- cheap at one venue's size but would want statement-level triggers for bulk loads.
--
-- Run as usrp_admin AFTER db:migrate, 0001, 0008, 0009, 0026, 0032, 0034.
-- Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1. Fleet columns ──────────────────────────────────────────────
ALTER TABLE public_core.field_devices
  ADD COLUMN IF NOT EXISTS last_seen_at     timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_source varchar(16),
  ADD COLUMN IF NOT EXISTS last_sync_at     timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_by       varchar(128),
  ADD COLUMN IF NOT EXISTS revoke_reason    varchar(24);

ALTER TABLE public_core.field_devices DROP CONSTRAINT IF EXISTS field_devices_last_seen_source_check;
ALTER TABLE public_core.field_devices ADD CONSTRAINT field_devices_last_seen_source_check
  CHECK (last_seen_source IS NULL OR last_seen_source IN ('FIELD_SYNC', 'BIOMETRIC'));
ALTER TABLE public_core.field_devices DROP CONSTRAINT IF EXISTS field_devices_revoke_reason_check;
ALTER TABLE public_core.field_devices ADD CONSTRAINT field_devices_revoke_reason_check
  CHECK (revoke_reason IS NULL OR revoke_reason IN ('LOST', 'STOLEN', 'COMPROMISED', 'RETIRED', 'OTHER'));
-- (No completeness CHECK: devices revoked by hand carry no actor or reason; the fleet
-- route always records both.)
ALTER TABLE public_core.field_devices DROP CONSTRAINT IF EXISTS field_devices_revocation_complete_check;

-- ── 2. Guard: key and agency immutable; revocation final ──────────
CREATE OR REPLACE FUNCTION public_core.guard_field_device_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.public_key_pem IS DISTINCT FROM OLD.public_key_pem
     OR NEW.agency IS DISTINCT FROM OLD.agency
     OR NEW.enrolled_by IS DISTINCT FROM OLD.enrolled_by
     OR NEW.enrolled_at IS DISTINCT FROM OLD.enrolled_at THEN
    RAISE EXCEPTION 'field_devices: the key, the agency and the enrolment record are immutable (rotate by revoke + new enrolment)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
          OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
          OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'field_devices: a revocation is final'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_field_devices_guard ON public_core.field_devices;
CREATE TRIGGER trg_field_devices_guard BEFORE UPDATE ON public_core.field_devices
  FOR EACH ROW EXECUTE FUNCTION public_core.guard_field_device_update();

-- ── Roles ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usrp_device_fleet_owner') THEN
    CREATE ROLE usrp_device_fleet_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usrp_venue_projection_owner') THEN
    CREATE ROLE usrp_venue_projection_owner NOLOGIN;
  END IF;
END$$;
ALTER ROLE usrp_device_fleet_owner
  WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN BYPASSRLS;
ALTER ROLE usrp_venue_projection_owner
  WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN BYPASSRLS;

-- The command owners are never members of anything and never assumable.
DO $$
DECLARE
  m record;
BEGIN
  FOR m IN
    SELECT granted.rolname AS granted_role, member.rolname AS member_role
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE granted.rolname IN ('usrp_device_fleet_owner', 'usrp_venue_projection_owner')
       OR member.rolname IN ('usrp_device_fleet_owner', 'usrp_venue_projection_owner')
  LOOP
    EXECUTE format('REVOKE %I FROM %I', m.granted_role, m.member_role);
  END LOOP;
END$$;

GRANT USAGE ON SCHEMA public_core TO usrp_device_fleet_owner, usrp_venue_projection_owner;

-- ── 3. touch_field_device: the last-seen stamp ────────────────────
GRANT SELECT (device_id, revoked_at, last_seen_at, last_sync_at) ON public_core.field_devices TO usrp_device_fleet_owner;
GRANT UPDATE (last_seen_at, last_seen_source, last_sync_at) ON public_core.field_devices TO usrp_device_fleet_owner;

CREATE OR REPLACE FUNCTION public_core.touch_field_device(p_device_id text, p_source text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE public_core.field_devices
     SET last_seen_at     = GREATEST(COALESCE(last_seen_at, '-infinity'::timestamptz), now()),
         last_seen_source = p_source,
         last_sync_at     = CASE WHEN p_source = 'FIELD_SYNC'
                                 THEN GREATEST(COALESCE(last_sync_at, '-infinity'::timestamptz), now())
                                 ELSE last_sync_at END
   WHERE device_id = p_device_id
     AND revoked_at IS NULL
     AND p_source IN ('FIELD_SYNC', 'BIOMETRIC')
$$;
-- the owner needs CREATE on the schema only for ALTER FUNCTION … OWNER; NOLOGIN, no dynamic SQL
GRANT CREATE ON SCHEMA public_core TO usrp_device_fleet_owner;
ALTER FUNCTION public_core.touch_field_device(text, text) OWNER TO usrp_device_fleet_owner;
REVOKE CREATE ON SCHEMA public_core FROM usrp_device_fleet_owner;
REVOKE ALL ON FUNCTION public_core.touch_field_device(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_core.touch_field_device(text, text)
  TO usrp_biometric_service, usrp_system_service;

-- ── 4. Device → venue-day assignment ──────────────────────────────
CREATE TABLE IF NOT EXISTS public_core.field_device_assignments (
  device_id    varchar(64)  NOT NULL REFERENCES public_core.field_devices (device_id),
  exam_date    date         NOT NULL,
  agency       public_core.agency NOT NULL,
  campaign_id  uuid         NOT NULL REFERENCES public_core.recruitment_campaigns (id),
  district     varchar(30)  NOT NULL,
  assigned_by  varchar(128) NOT NULL,
  assigned_at  timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, exam_date)
);
CREATE INDEX IF NOT EXISTS idx_pc_fda_agency_venue
  ON public_core.field_device_assignments (agency, campaign_id, district, exam_date);

GRANT SELECT, INSERT, UPDATE ON public_core.field_device_assignments TO usrp_system_service;
REVOKE DELETE, TRUNCATE ON public_core.field_device_assignments FROM usrp_system_service;
GRANT SELECT ON public_core.field_device_assignments TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;
GRANT SELECT ON public_core.recruitment_campaigns TO usrp_system_service;
ALTER TABLE public_core.field_device_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.field_device_assignments FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pc_fda_system ON public_core.field_device_assignments;
CREATE POLICY pc_fda_system ON public_core.field_device_assignments
  TO usrp_system_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS pc_fda_rdf ON public_core.field_device_assignments;
CREATE POLICY pc_fda_rdf ON public_core.field_device_assignments TO usrp_rdf_officer USING (agency = 'RDF');
DROP POLICY IF EXISTS pc_fda_rnp ON public_core.field_device_assignments;
CREATE POLICY pc_fda_rnp ON public_core.field_device_assignments TO usrp_rnp_officer USING (agency = 'RNP');
DROP POLICY IF EXISTS pc_fda_rcs ON public_core.field_device_assignments;
CREATE POLICY pc_fda_rcs ON public_core.field_device_assignments TO usrp_rcs_officer USING (agency = 'RCS');

-- ── Outbox lane for field-sync's fleet audits ─────────────────────
-- pc_event_outbox_system admits only application-/scheduling-service rows. The
-- fleet audit (revoke, assign) is staged by field-sync in the same transaction
-- as the state change, so it needs its own narrow lane: one producer, one event
-- type, two actions. (Permissive policies are OR-ed; nothing is widened.)
DROP POLICY IF EXISTS pc_event_outbox_fleet ON public_core.event_outbox;
CREATE POLICY pc_event_outbox_fleet ON public_core.event_outbox
  FOR ALL TO usrp_system_service USING (producer = 'field-sync-service') WITH CHECK (
    producer = 'field-sync-service'
    AND event_type = 'AUDIT_ENTRY'
    AND payload->>'eventType' = 'AUDIT_ENTRY'
    AND payload->>'action' IN ('FIELD_DEVICE_REVOKED', 'FIELD_DEVICE_ASSIGNED')
  );

-- ── 5. Venue live counts ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public_core.venue_day_counts (
  campaign_id        uuid        NOT NULL REFERENCES public_core.recruitment_campaigns (id),
  district           varchar(30) NOT NULL,
  exam_date          date        NOT NULL,
  agency             public_core.agency NOT NULL,
  expected           integer     NOT NULL DEFAULT 0 CHECK (expected >= 0),
  admitted           integer     NOT NULL DEFAULT 0 CHECK (admitted >= 0),
  physical_captured  integer     NOT NULL DEFAULT 0 CHECK (physical_captured >= 0),
  medical_recorded   integer     NOT NULL DEFAULT 0 CHECK (medical_recorded >= 0),
  open_conflicts     integer     NOT NULL DEFAULT 0 CHECK (open_conflicts >= 0),
  as_of              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, district, exam_date)
);
CREATE INDEX IF NOT EXISTS idx_pc_vdc_agency ON public_core.venue_day_counts (agency, exam_date);

ALTER TABLE public_core.venue_day_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.venue_day_counts FORCE  ROW LEVEL SECURITY;
REVOKE ALL ON public_core.venue_day_counts FROM PUBLIC;
GRANT SELECT ON public_core.venue_day_counts
  TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer, usrp_system_service;
GRANT SELECT, INSERT, UPDATE ON public_core.venue_day_counts TO usrp_venue_projection_owner;
DROP POLICY IF EXISTS pc_vdc_system ON public_core.venue_day_counts;
CREATE POLICY pc_vdc_system ON public_core.venue_day_counts FOR SELECT TO usrp_system_service USING (true);
DROP POLICY IF EXISTS pc_vdc_rdf ON public_core.venue_day_counts;
CREATE POLICY pc_vdc_rdf ON public_core.venue_day_counts FOR SELECT TO usrp_rdf_officer USING (agency = 'RDF');
DROP POLICY IF EXISTS pc_vdc_rnp ON public_core.venue_day_counts;
CREATE POLICY pc_vdc_rnp ON public_core.venue_day_counts FOR SELECT TO usrp_rnp_officer USING (agency = 'RNP');
DROP POLICY IF EXISTS pc_vdc_rcs ON public_core.venue_day_counts;
CREATE POLICY pc_vdc_rcs ON public_core.venue_day_counts FOR SELECT TO usrp_rcs_officer USING (agency = 'RCS');

GRANT SELECT ON public_core.recruitment_campaigns, public_core.campaign_venue_assignments
  TO usrp_venue_projection_owner;

DO $$
DECLARE
  s text;
  a text;
  fn text;
BEGIN
  FOREACH s IN ARRAY ARRAY['rdf_ops', 'rnp_ops', 'rcs_ops'] LOOP
    a := split_part(s, '_', 1);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO usrp_venue_projection_owner', s);
    EXECUTE format('GRANT SELECT ON %I.applications, %I.gate_admissions, %I.physical_test_scores TO usrp_venue_projection_owner', s, s, s);
    EXECUTE format('GRANT CREATE ON SCHEMA %I TO usrp_venue_projection_owner', s);

    -- Recompute the five counts of one venue day. Never called by a role: only by
    -- the trigger functions below (same owner).
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.venue_day_refresh(p_campaign uuid, p_district text)
      RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
        -- Serialise refreshes of ONE venue day: a concurrent writer waits here, and
        -- the statement below then sees its committed rows (READ COMMITTED), so the
        -- last refresh never stores a stale count.
        SELECT pg_advisory_xact_lock(hashtextextended(p_campaign::text || '/' || p_district, 36));
        INSERT INTO public_core.venue_day_counts
          (campaign_id, district, exam_date, agency, expected, admitted,
           physical_captured, medical_recorded, open_conflicts, as_of)
        SELECT v.campaign_id, v.district, v.exam_date::date, c.agency,
          (SELECT count(*) FROM %1$I.applications a
            WHERE a.campaign_id = v.campaign_id AND a.assigned_district = v.district
              AND a.status::text IN ('SLOT_ASSIGNED', 'PHYSICAL_TEST_SCHEDULED', 'PHYSICAL_TEST_COMPLETE')),
          (SELECT count(*) FROM %1$I.gate_admissions g
             JOIN %1$I.applications a ON a.id = g.application_id
            WHERE a.campaign_id = v.campaign_id AND a.assigned_district = v.district),
          (SELECT count(DISTINCT sc.application_id) FROM %1$I.physical_test_scores sc
             JOIN %1$I.applications a ON a.id = sc.application_id
            WHERE a.campaign_id = v.campaign_id AND a.assigned_district = v.district),
          (SELECT count(DISTINCT sc.application_id) FROM %1$I.physical_test_scores sc
             JOIN %1$I.applications a ON a.id = sc.application_id
            WHERE a.campaign_id = v.campaign_id AND a.assigned_district = v.district
              AND sc.medical_fitness_status IS NOT NULL),
          (SELECT count(DISTINCT sc.application_id) FROM %1$I.physical_test_scores sc
             JOIN %1$I.applications a ON a.id = sc.application_id
            WHERE a.campaign_id = v.campaign_id AND a.assigned_district = v.district
              AND sc.sync_conflict_detected IS TRUE),
          now()
        FROM public_core.campaign_venue_assignments v
        JOIN public_core.recruitment_campaigns c ON c.id = v.campaign_id
        WHERE v.campaign_id = p_campaign AND v.district = p_district
          AND c.agency = %2$L::public_core.agency
        ON CONFLICT (campaign_id, district, exam_date) DO UPDATE SET
          expected = EXCLUDED.expected, admitted = EXCLUDED.admitted,
          physical_captured = EXCLUDED.physical_captured,
          medical_recorded = EXCLUDED.medical_recorded,
          open_conflicts = EXCLUDED.open_conflicts,
          as_of = EXCLUDED.as_of
      $body$
    $f$, s, upper(a));

    -- applications: entering, leaving or moving between venues
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.trg_venue_day_application() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
      BEGIN
        IF NEW.assigned_district IS NOT NULL THEN
          PERFORM %1$I.venue_day_refresh(NEW.campaign_id, NEW.assigned_district);
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.assigned_district IS NOT NULL
           AND OLD.assigned_district IS DISTINCT FROM NEW.assigned_district THEN
          PERFORM %1$I.venue_day_refresh(OLD.campaign_id, OLD.assigned_district);
        END IF;
        RETURN NULL;
      END
      $body$
    $f$, s);

    -- gate admissions and physical scores: resolve the venue through the application
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.trg_venue_day_child() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
      DECLARE
        v_campaign uuid;
        v_district text;
      BEGIN
        SELECT a.campaign_id, a.assigned_district INTO v_campaign, v_district
          FROM %1$I.applications a WHERE a.id = NEW.application_id;
        IF v_district IS NOT NULL THEN
          PERFORM %1$I.venue_day_refresh(v_campaign, v_district);
        END IF;
        RETURN NULL;
      END
      $body$
    $f$, s);

    FOREACH fn IN ARRAY ARRAY['venue_day_refresh(uuid, text)', 'trg_venue_day_application()', 'trg_venue_day_child()'] LOOP
      EXECUTE format('ALTER FUNCTION %I.%s OWNER TO usrp_venue_projection_owner', s, fn);
      EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC', s, fn);
    END LOOP;
    EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM usrp_venue_projection_owner', s);

    -- Backfill: venue days that already have data must not read as empty.
    EXECUTE format($q$
      SELECT %1$I.venue_day_refresh(v.campaign_id, v.district)
      FROM public_core.campaign_venue_assignments v
      JOIN public_core.recruitment_campaigns c ON c.id = v.campaign_id
      WHERE c.agency = %2$L::public_core.agency
    $q$, s, upper(a));

    EXECUTE format('DROP TRIGGER IF EXISTS trg_venue_day_application ON %I.applications', s);
    EXECUTE format('CREATE TRIGGER trg_venue_day_application AFTER INSERT OR UPDATE OF status, assigned_district ON %I.applications FOR EACH ROW EXECUTE FUNCTION %I.trg_venue_day_application()', s, s);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_venue_day_admission ON %I.gate_admissions', s);
    EXECUTE format('CREATE TRIGGER trg_venue_day_admission AFTER INSERT ON %I.gate_admissions FOR EACH ROW EXECUTE FUNCTION %I.trg_venue_day_child()', s, s);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_venue_day_scores ON %I.physical_test_scores', s);
    EXECUTE format('CREATE TRIGGER trg_venue_day_scores AFTER INSERT OR UPDATE OF sync_conflict_detected, medical_fitness_status ON %I.physical_test_scores FOR EACH ROW EXECUTE FUNCTION %I.trg_venue_day_child()', s, s);
  END LOOP;
END$$;

COMMIT;
