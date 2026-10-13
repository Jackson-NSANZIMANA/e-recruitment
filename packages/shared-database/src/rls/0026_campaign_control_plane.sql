-- BUILD-001 — Campaign & Policy Control Plane authorization and invariants.
-- Source-of-truth roles remain agency-scoped officer roles. The only new role
-- is a view-only public reader that can select an explicit public projection.
--
-- Campaign state belongs to application-service; session/coverage writes
-- belong to scheduling-service. Both session mutation and publication serialize
-- on recruitment_campaigns FOR UPDATE before touching coverage/session rows.
-- The coverage head is evidence of the exact set, never the lock that provides
-- serialization.

BEGIN;

-- Narrow anonymous-read DB role: it can read one safe, published-only view and
-- cannot select campaign UUIDs, policy data, coverage, counts, audit or actors.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usrp_campaign_public_reader') THEN
    CREATE ROLE usrp_campaign_public_reader NOLOGIN;
  END IF;
END$$;
GRANT usrp_campaign_public_reader TO usrp_app;
GRANT USAGE ON SCHEMA public_core TO usrp_campaign_public_reader;

-- Campaign authoring and lifecycle. UPDATE is column-scoped; there is no
-- campaign DELETE grant. Each officer role remains confined by agency RLS.
GRANT SELECT, INSERT ON public_core.recruitment_campaigns
  TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;
GRANT UPDATE (current_policy_version_id, status, published_at,
              registration_closed_at, cancelled_at, updated_at)
  ON public_core.recruitment_campaigns
  TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;

GRANT SELECT, INSERT ON public_core.campaign_policy_versions,
  public_core.campaign_publications,
  public_core.campaign_lifecycle_history,
  public_core.campaign_command_requests
  TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;

-- Session configuration is scheduling-owned. The campaign-specific agency
-- row policy scopes these narrow writes; registered_count remains exclusively
-- the existing system-service column grant from 0021.
GRANT SELECT, INSERT ON public_core.campaign_venue_assignments
  TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;
GRANT UPDATE (district, province, venue_name, exam_date, reporting_time_hour,
              capacity_limit, is_active)
  ON public_core.campaign_venue_assignments
  TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;
GRANT SELECT, INSERT, UPDATE ON public_core.campaign_coverage_heads
  TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;
GRANT SELECT, INSERT ON public_core.session_command_requests
  TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;

-- The system scheduler retains exactly its prior read path and registered_count
-- column write. RLS policies below do not add any new system-service grants.

-- Campaign public projection: security_invoker means the public reader needs
-- column-level SELECT and the RLS policies below. Its query never selects an
-- internal campaign UUID or joins on one.
GRANT SELECT (public_code, campaign_label, agency, status,
              registration_opens_at, registration_closes_at,
              examination_start_date, examination_end_date,
              target_categories, target_districts, allows_walk_in,
              contact_phone_numbers, contact_website)
  ON public_core.recruitment_campaigns TO usrp_campaign_public_reader;
GRANT SELECT (public_code) ON public_core.campaign_publications
  TO usrp_campaign_public_reader;

-- ── FORCE'd RLS: campaign root ─────────────────────────────────────────────
ALTER TABLE public_core.recruitment_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.recruitment_campaigns FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pc_campaign_system_read ON public_core.recruitment_campaigns;
CREATE POLICY pc_campaign_system_read ON public_core.recruitment_campaigns
  FOR SELECT TO usrp_system_service USING (true);

DROP POLICY IF EXISTS pc_campaign_rdf ON public_core.recruitment_campaigns;
CREATE POLICY pc_campaign_rdf ON public_core.recruitment_campaigns
  FOR ALL TO usrp_rdf_officer USING (agency = 'RDF') WITH CHECK (agency = 'RDF');
DROP POLICY IF EXISTS pc_campaign_rnp ON public_core.recruitment_campaigns;
CREATE POLICY pc_campaign_rnp ON public_core.recruitment_campaigns
  FOR ALL TO usrp_rnp_officer USING (agency = 'RNP') WITH CHECK (agency = 'RNP');
DROP POLICY IF EXISTS pc_campaign_rcs ON public_core.recruitment_campaigns;
CREATE POLICY pc_campaign_rcs ON public_core.recruitment_campaigns
  FOR ALL TO usrp_rcs_officer USING (agency = 'RCS') WITH CHECK (agency = 'RCS');

-- Rows become visible to the anonymous projection iff their stable public code
-- is present in the immutable publication ledger. No legacy published_at value
-- alone can make an old campaign public.
DROP POLICY IF EXISTS pc_campaign_public_reader ON public_core.recruitment_campaigns;
CREATE POLICY pc_campaign_public_reader ON public_core.recruitment_campaigns
  FOR SELECT TO usrp_campaign_public_reader
  USING (EXISTS (
    SELECT 1 FROM public_core.campaign_publications p
    WHERE p.public_code = recruitment_campaigns.public_code
  ));

-- Application submission must serialize against cancellation, but the
-- cross-agency system worker deliberately has no UPDATE privilege on campaigns.
-- This tiny definer function exposes only the campaign status while taking the
-- shared row lock; it does not grant a direct lock/update capability on the
-- table and is executable only by the existing system-service role.
CREATE OR REPLACE FUNCTION public_core.lock_campaign_for_application_insert(
  p_campaign_id uuid,
  p_agency public_core.agency
)
RETURNS TABLE (status public_core.campaign_status)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_allowed_agency public_core.agency;
BEGIN
  -- SECURITY DEFINER bypasses table RLS/column grants only for this single
  -- status+lock operation. Bind officer roles to their verified agency; the
  -- existing system submission role may operate across agencies as before.
  CASE current_setting('role', true)
    WHEN 'usrp_system_service' THEN v_allowed_agency := p_agency;
    WHEN 'usrp_rdf_officer' THEN v_allowed_agency := 'RDF';
    WHEN 'usrp_rnp_officer' THEN v_allowed_agency := 'RNP';
    WHEN 'usrp_rcs_officer' THEN v_allowed_agency := 'RCS';
    ELSE RETURN;
  END CASE;
  IF v_allowed_agency IS DISTINCT FROM p_agency THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT c.status
    FROM public_core.recruitment_campaigns AS c
    WHERE c.id = p_campaign_id AND c.agency = v_allowed_agency
    FOR SHARE;
END;
$function$;
REVOKE ALL ON FUNCTION public_core.lock_campaign_for_application_insert(uuid, public_core.agency)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_core.lock_campaign_for_application_insert(uuid, public_core.agency)
  TO usrp_system_service, usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;

-- ── Policy versions: own-agency select/insert, never update/delete ─────────
ALTER TABLE public_core.campaign_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.campaign_policy_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pc_policy_versions_rdf ON public_core.campaign_policy_versions;
CREATE POLICY pc_policy_versions_rdf ON public_core.campaign_policy_versions
  FOR ALL TO usrp_rdf_officer USING (agency = 'RDF') WITH CHECK (agency = 'RDF');
DROP POLICY IF EXISTS pc_policy_versions_rnp ON public_core.campaign_policy_versions;
CREATE POLICY pc_policy_versions_rnp ON public_core.campaign_policy_versions
  FOR ALL TO usrp_rnp_officer USING (agency = 'RNP') WITH CHECK (agency = 'RNP');
DROP POLICY IF EXISTS pc_policy_versions_rcs ON public_core.campaign_policy_versions;
CREATE POLICY pc_policy_versions_rcs ON public_core.campaign_policy_versions
  FOR ALL TO usrp_rcs_officer USING (agency = 'RCS') WITH CHECK (agency = 'RCS');

-- ── Immutable publications ────────────────────────────────────────────────
ALTER TABLE public_core.campaign_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.campaign_publications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pc_publications_rdf ON public_core.campaign_publications;
CREATE POLICY pc_publications_rdf ON public_core.campaign_publications
  FOR ALL TO usrp_rdf_officer USING (agency = 'RDF') WITH CHECK (agency = 'RDF');
DROP POLICY IF EXISTS pc_publications_rnp ON public_core.campaign_publications;
CREATE POLICY pc_publications_rnp ON public_core.campaign_publications
  FOR ALL TO usrp_rnp_officer USING (agency = 'RNP') WITH CHECK (agency = 'RNP');
DROP POLICY IF EXISTS pc_publications_rcs ON public_core.campaign_publications;
CREATE POLICY pc_publications_rcs ON public_core.campaign_publications
  FOR ALL TO usrp_rcs_officer USING (agency = 'RCS') WITH CHECK (agency = 'RCS');
DROP POLICY IF EXISTS pc_publications_public_code_read ON public_core.campaign_publications;
CREATE POLICY pc_publications_public_code_read ON public_core.campaign_publications
  FOR SELECT TO usrp_campaign_public_reader USING (true);

-- ── Append-only lifecycle and command ledgers ─────────────────────────────
ALTER TABLE public_core.campaign_lifecycle_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.campaign_lifecycle_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pc_campaign_history_rdf ON public_core.campaign_lifecycle_history;
CREATE POLICY pc_campaign_history_rdf ON public_core.campaign_lifecycle_history
  FOR ALL TO usrp_rdf_officer USING (agency = 'RDF') WITH CHECK (agency = 'RDF');
DROP POLICY IF EXISTS pc_campaign_history_rnp ON public_core.campaign_lifecycle_history;
CREATE POLICY pc_campaign_history_rnp ON public_core.campaign_lifecycle_history
  FOR ALL TO usrp_rnp_officer USING (agency = 'RNP') WITH CHECK (agency = 'RNP');
DROP POLICY IF EXISTS pc_campaign_history_rcs ON public_core.campaign_lifecycle_history;
CREATE POLICY pc_campaign_history_rcs ON public_core.campaign_lifecycle_history
  FOR ALL TO usrp_rcs_officer USING (agency = 'RCS') WITH CHECK (agency = 'RCS');

ALTER TABLE public_core.campaign_command_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.campaign_command_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pc_campaign_commands_rdf ON public_core.campaign_command_requests;
CREATE POLICY pc_campaign_commands_rdf ON public_core.campaign_command_requests
  FOR ALL TO usrp_rdf_officer USING (agency = 'RDF') WITH CHECK (agency = 'RDF');
DROP POLICY IF EXISTS pc_campaign_commands_rnp ON public_core.campaign_command_requests;
CREATE POLICY pc_campaign_commands_rnp ON public_core.campaign_command_requests
  FOR ALL TO usrp_rnp_officer USING (agency = 'RNP') WITH CHECK (agency = 'RNP');
DROP POLICY IF EXISTS pc_campaign_commands_rcs ON public_core.campaign_command_requests;
CREATE POLICY pc_campaign_commands_rcs ON public_core.campaign_command_requests
  FOR ALL TO usrp_rcs_officer USING (agency = 'RCS') WITH CHECK (agency = 'RCS');

ALTER TABLE public_core.session_command_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.session_command_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pc_session_commands_rdf ON public_core.session_command_requests;
CREATE POLICY pc_session_commands_rdf ON public_core.session_command_requests
  FOR ALL TO usrp_rdf_officer USING (agency = 'RDF') WITH CHECK (agency = 'RDF');
DROP POLICY IF EXISTS pc_session_commands_rnp ON public_core.session_command_requests;
CREATE POLICY pc_session_commands_rnp ON public_core.session_command_requests
  FOR ALL TO usrp_rnp_officer USING (agency = 'RNP') WITH CHECK (agency = 'RNP');
DROP POLICY IF EXISTS pc_session_commands_rcs ON public_core.session_command_requests;
CREATE POLICY pc_session_commands_rcs ON public_core.session_command_requests
  FOR ALL TO usrp_rcs_officer USING (agency = 'RCS') WITH CHECK (agency = 'RCS');

-- ── Scheduling-owned coverage and sessions ─────────────────────────────────
ALTER TABLE public_core.campaign_coverage_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.campaign_coverage_heads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pc_coverage_heads_rdf ON public_core.campaign_coverage_heads;
CREATE POLICY pc_coverage_heads_rdf ON public_core.campaign_coverage_heads
  FOR ALL TO usrp_rdf_officer USING (agency = 'RDF') WITH CHECK (agency = 'RDF');
DROP POLICY IF EXISTS pc_coverage_heads_rnp ON public_core.campaign_coverage_heads;
CREATE POLICY pc_coverage_heads_rnp ON public_core.campaign_coverage_heads
  FOR ALL TO usrp_rnp_officer USING (agency = 'RNP') WITH CHECK (agency = 'RNP');
DROP POLICY IF EXISTS pc_coverage_heads_rcs ON public_core.campaign_coverage_heads;
CREATE POLICY pc_coverage_heads_rcs ON public_core.campaign_coverage_heads
  FOR ALL TO usrp_rcs_officer USING (agency = 'RCS') WITH CHECK (agency = 'RCS');

ALTER TABLE public_core.campaign_venue_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.campaign_venue_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pc_venue_system_capacity ON public_core.campaign_venue_assignments;
DROP POLICY IF EXISTS pc_venue_system_select ON public_core.campaign_venue_assignments;
DROP POLICY IF EXISTS pc_venue_system_update ON public_core.campaign_venue_assignments;
CREATE POLICY pc_venue_system_select ON public_core.campaign_venue_assignments
  FOR SELECT TO usrp_system_service USING (true);
CREATE POLICY pc_venue_system_update ON public_core.campaign_venue_assignments
  FOR UPDATE TO usrp_system_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS pc_venue_rdf ON public_core.campaign_venue_assignments;
CREATE POLICY pc_venue_rdf ON public_core.campaign_venue_assignments
  FOR ALL TO usrp_rdf_officer
  USING (EXISTS (
    SELECT 1 FROM public_core.recruitment_campaigns c
    WHERE c.id = campaign_venue_assignments.campaign_id AND c.agency = 'RDF'
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public_core.recruitment_campaigns c
    WHERE c.id = campaign_venue_assignments.campaign_id AND c.agency = 'RDF'
  ));
DROP POLICY IF EXISTS pc_venue_rnp ON public_core.campaign_venue_assignments;
CREATE POLICY pc_venue_rnp ON public_core.campaign_venue_assignments
  FOR ALL TO usrp_rnp_officer
  USING (EXISTS (
    SELECT 1 FROM public_core.recruitment_campaigns c
    WHERE c.id = campaign_venue_assignments.campaign_id AND c.agency = 'RNP'
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public_core.recruitment_campaigns c
    WHERE c.id = campaign_venue_assignments.campaign_id AND c.agency = 'RNP'
  ));
DROP POLICY IF EXISTS pc_venue_rcs ON public_core.campaign_venue_assignments;
CREATE POLICY pc_venue_rcs ON public_core.campaign_venue_assignments
  FOR ALL TO usrp_rcs_officer
  USING (EXISTS (
    SELECT 1 FROM public_core.recruitment_campaigns c
    WHERE c.id = campaign_venue_assignments.campaign_id AND c.agency = 'RCS'
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public_core.recruitment_campaigns c
    WHERE c.id = campaign_venue_assignments.campaign_id AND c.agency = 'RCS'
  ));

-- ── View-only public campaign contract ────────────────────────────────────
CREATE OR REPLACE VIEW public_core.campaign_public_read
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  c.public_code,
  c.campaign_label,
  c.agency,
  c.status,
  c.registration_opens_at,
  c.registration_closes_at,
  c.examination_start_date,
  c.examination_end_date,
  c.target_categories,
  c.target_districts,
  c.allows_walk_in,
  c.contact_phone_numbers,
  c.contact_website
FROM public_core.recruitment_campaigns AS c
WHERE c.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'CANCELLED', 'COMPLETED')
  AND EXISTS (
    SELECT 1 FROM public_core.campaign_publications AS p
    WHERE p.public_code = c.public_code
  );
GRANT SELECT ON public_core.campaign_public_read TO usrp_campaign_public_reader;

-- ── Append-only enforcement for immutable facts ────────────────────────────
CREATE OR REPLACE FUNCTION public_core.reject_campaign_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'campaign_policy_versions',
    'campaign_publications',
    'campaign_lifecycle_history',
    'campaign_command_requests',
    'session_command_requests'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public_core.%I', 'trg_' || v_table || '_no_update_delete', v_table);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public_core.%I FOR EACH ROW EXECUTE FUNCTION public_core.reject_campaign_fact_mutation()',
      'trg_' || v_table || '_no_update_delete', v_table
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public_core.%I', 'trg_' || v_table || '_no_truncate', v_table);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON public_core.%I FOR EACH STATEMENT EXECUTE FUNCTION public_core.reject_campaign_fact_mutation()',
      'trg_' || v_table || '_no_truncate', v_table
    );
  END LOOP;
END$$;

-- A policy version is appendable only while its campaign is a draft. The row
-- lock serializes version-number allocation with publication and other writes.
CREATE OR REPLACE FUNCTION public_core.guard_campaign_policy_version_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status public_core.campaign_status;
  v_next_version integer;
BEGIN
  SELECT c.status INTO v_status
  FROM public_core.recruitment_campaigns c
  WHERE c.id = NEW.campaign_id AND c.agency = NEW.agency
  FOR UPDATE;
  IF NOT FOUND OR v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'policy versions can be added only to an owned draft campaign'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(max(p.version_number), 0) + 1 INTO v_next_version
  FROM public_core.campaign_policy_versions p
  WHERE p.campaign_id = NEW.campaign_id;
  IF NEW.version_number <> v_next_version THEN
    RAISE EXCEPTION 'campaign policy version must be the next monotonic version'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_campaign_policy_version_guard ON public_core.campaign_policy_versions;
CREATE TRIGGER trg_campaign_policy_version_guard
  BEFORE INSERT ON public_core.campaign_policy_versions
  FOR EACH ROW EXECUTE FUNCTION public_core.guard_campaign_policy_version_insert();

-- Session configuration trigger. Every configuration write locks the campaign
-- row first. The existing reservation worker's registered_count-only updates
-- are explicitly exempt so 0021 capacity semantics remain unchanged.
CREATE OR REPLACE FUNCTION public_core.guard_campaign_session_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_campaign_id uuid;
  v_status public_core.campaign_status;
  v_target_districts jsonb;
  v_exam_start varchar(10);
  v_exam_end varchar(10);
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_user = 'usrp_system_service'
     AND ROW(NEW.id, NEW.campaign_id, NEW.district, NEW.province, NEW.venue_name,
             NEW.exam_date, NEW.reporting_time_hour, NEW.capacity_limit,
             NEW.is_active, NEW.created_at)
         IS NOT DISTINCT FROM
         ROW(OLD.id, OLD.campaign_id, OLD.district, OLD.province, OLD.venue_name,
             OLD.exam_date, OLD.reporting_time_hour, OLD.capacity_limit,
             OLD.is_active, OLD.created_at)
     AND NEW.registered_count IS DISTINCT FROM OLD.registered_count THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'campaign sessions are deactivated, not deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_campaign_id := NEW.campaign_id;
  IF TG_OP = 'UPDATE' AND NEW.campaign_id IS DISTINCT FROM OLD.campaign_id THEN
    RAISE EXCEPTION 'a campaign session cannot be moved to another campaign'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT c.status, c.target_districts, c.examination_start_date, c.examination_end_date
    INTO v_status, v_target_districts, v_exam_start, v_exam_end
  FROM public_core.recruitment_campaigns c
  WHERE c.id = v_campaign_id
  FOR UPDATE;
  IF NOT FOUND OR v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'campaign sessions can be configured only for a draft campaign'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.registered_count <> 0 THEN
      RAISE EXCEPTION 'new campaign session registered_count must be zero'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.registered_count IS DISTINCT FROM OLD.registered_count THEN
      RAISE EXCEPTION 'campaign session configuration cannot change registered_count'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.registered_count > 0 AND
       ROW(NEW.district, NEW.province, NEW.venue_name, NEW.exam_date,
           NEW.reporting_time_hour, NEW.capacity_limit, NEW.is_active)
       IS DISTINCT FROM
       ROW(OLD.district, OLD.province, OLD.venue_name, OLD.exam_date,
           OLD.reporting_time_hour, OLD.capacity_limit, OLD.is_active) THEN
      RAISE EXCEPTION 'a session with registered applicants cannot be reconfigured'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF v_target_districts IS NULL OR NOT (v_target_districts @> jsonb_build_array(NEW.district)) THEN
    RAISE EXCEPTION 'session district is not in the campaign target set'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.exam_date < v_exam_start OR NEW.exam_date > v_exam_end THEN
    RAISE EXCEPTION 'session exam date is outside the campaign examination window'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reporting_time_hour < 0 OR NEW.reporting_time_hour > 23 THEN
    RAISE EXCEPTION 'session reporting hour must be between 0 and 23'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.capacity_limit IS NOT NULL AND NEW.capacity_limit <= 0 THEN
    RAISE EXCEPTION 'session capacity must be positive or unbounded'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_campaign_session_guard ON public_core.campaign_venue_assignments;
CREATE TRIGGER trg_campaign_session_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public_core.campaign_venue_assignments
  FOR EACH ROW EXECUTE FUNCTION public_core.guard_campaign_session_write();

-- Coverage head changes are a scheduling operation. The head itself is locked
-- after the campaign row and advances exactly once for a changed session set.
CREATE OR REPLACE FUNCTION public_core.guard_campaign_coverage_head_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status public_core.campaign_status;
BEGIN
  SELECT c.status INTO v_status
  FROM public_core.recruitment_campaigns c
  WHERE c.id = NEW.campaign_id AND c.agency = NEW.agency
  FOR UPDATE;
  IF NOT FOUND OR v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'coverage can be changed only for a draft campaign'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.coverage_version <> 0 THEN
    RAISE EXCEPTION 'a new coverage head starts at version zero'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND
     (NEW.coverage_version <> OLD.coverage_version + 1 OR NEW.coverage_hash = OLD.coverage_hash) THEN
    RAISE EXCEPTION 'coverage head must advance one version with a changed hash'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_campaign_coverage_head_guard ON public_core.campaign_coverage_heads;
CREATE TRIGGER trg_campaign_coverage_head_guard
  BEFORE INSERT OR UPDATE ON public_core.campaign_coverage_heads
  FOR EACH ROW EXECUTE FUNCTION public_core.guard_campaign_coverage_head_write();

-- Publication rows may only freeze the campaign's currently selected policy
-- and the locked coverage head, while the campaign is still a draft.
CREATE OR REPLACE FUNCTION public_core.guard_campaign_publication_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status public_core.campaign_status;
  v_current_policy uuid;
  v_public_code varchar(64);
  v_coverage_version integer;
  v_coverage_hash varchar(64);
BEGIN
  SELECT c.status, c.current_policy_version_id, c.public_code
    INTO v_status, v_current_policy, v_public_code
  FROM public_core.recruitment_campaigns c
  WHERE c.id = NEW.campaign_id AND c.agency = NEW.agency
  FOR UPDATE;
  IF NOT FOUND OR v_status <> 'DRAFT'
     OR v_current_policy IS DISTINCT FROM NEW.policy_version_id
     OR v_public_code IS DISTINCT FROM NEW.public_code THEN
    RAISE EXCEPTION 'publication must use the owned draft campaign and its selected policy'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT h.coverage_version, h.coverage_hash
    INTO v_coverage_version, v_coverage_hash
  FROM public_core.campaign_coverage_heads h
  WHERE h.campaign_id = NEW.campaign_id AND h.agency = NEW.agency
  FOR UPDATE;
  IF NOT FOUND OR v_coverage_version <> NEW.coverage_version
     OR v_coverage_hash IS DISTINCT FROM NEW.coverage_hash THEN
    RAISE EXCEPTION 'publication coverage does not match the locked coverage head'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_campaign_publication_guard ON public_core.campaign_publications;
CREATE TRIGGER trg_campaign_publication_guard
  BEFORE INSERT ON public_core.campaign_publications
  FOR EACH ROW EXECUTE FUNCTION public_core.guard_campaign_publication_insert();

-- The immutable publication fact and the externally visible state must become
-- durable together. A direct publication-ledger insert that leaves the root in
-- DRAFT is rejected at commit rather than exposing an unpublished campaign.
CREATE OR REPLACE FUNCTION public_core.require_campaign_publication_open()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status public_core.campaign_status;
BEGIN
  SELECT c.status INTO v_status
  FROM public_core.recruitment_campaigns c
  WHERE c.id = NEW.campaign_id AND c.agency = NEW.agency;
  IF NOT FOUND OR v_status NOT IN (
    'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'CANCELLED', 'COMPLETED'
  ) THEN
    RAISE EXCEPTION 'publication fact requires a publicly published campaign state'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_campaign_publication_state_required ON public_core.campaign_publications;
CREATE CONSTRAINT TRIGGER trg_campaign_publication_state_required
  AFTER INSERT ON public_core.campaign_publications
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public_core.require_campaign_publication_open();

-- New campaign rows can enter only in DRAFT, with no transition timestamps or
-- selected policy. Legacy rows have already been backfilled and are untouched.
CREATE OR REPLACE FUNCTION public_core.guard_campaign_initial_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'DRAFT'
     OR NEW.current_policy_version_id IS NOT NULL
     OR NEW.published_at IS NOT NULL
     OR NEW.registration_closed_at IS NOT NULL
     OR NEW.cancelled_at IS NOT NULL
     OR NEW.target_districts IS NULL
     OR jsonb_typeof(NEW.target_districts) <> 'array'
     OR jsonb_array_length(NEW.target_districts) = 0
     OR NEW.public_code LIKE 'LEGACY-%' THEN
    RAISE EXCEPTION 'new campaigns must begin as a complete DRAFT control-plane record'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_campaign_initial_state_guard ON public_core.recruitment_campaigns;
CREATE TRIGGER trg_campaign_initial_state_guard
  BEFORE INSERT ON public_core.recruitment_campaigns
  FOR EACH ROW EXECUTE FUNCTION public_core.guard_campaign_initial_state();

-- Exact BUILD-001 lifecycle graph and associated timestamps. Legacy enum value
-- EXAMINATION_ACTIVE remains present but is not a legal control-plane edge.
CREATE OR REPLACE FUNCTION public_core.guard_campaign_lifecycle_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_has_application boolean := false;
BEGIN
  IF ROW(NEW.campaign_label, NEW.agency, NEW.public_code, NEW.target_categories,
         NEW.target_districts, NEW.registration_opens_at, NEW.registration_closes_at,
         NEW.examination_start_date, NEW.examination_end_date,
         NEW.examination_reporting_hour, NEW.allows_walk_in, NEW.target_intake_count,
         NEW.contact_phone_numbers, NEW.contact_website, NEW.announcement_reference,
         NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.campaign_label, OLD.agency, OLD.public_code, OLD.target_categories,
         OLD.target_districts, OLD.registration_opens_at, OLD.registration_closes_at,
         OLD.examination_start_date, OLD.examination_end_date,
         OLD.examination_reporting_hour, OLD.allows_walk_in, OLD.target_intake_count,
         OLD.contact_phone_numbers, OLD.contact_website, OLD.announcement_reference,
         OLD.created_at) THEN
    RAISE EXCEPTION 'campaign structure is immutable after draft creation'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.current_policy_version_id IS DISTINCT FROM OLD.current_policy_version_id
     AND (OLD.status <> 'DRAFT' OR NEW.status <> 'DRAFT') THEN
    RAISE EXCEPTION 'the selected policy is frozen once a campaign is published'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'DRAFT' AND NEW.status IN ('REGISTRATION_OPEN', 'CANCELLED')) OR
      (OLD.status = 'REGISTRATION_OPEN' AND NEW.status IN ('REGISTRATION_CLOSED', 'CANCELLED')) OR
      (OLD.status = 'REGISTRATION_CLOSED' AND NEW.status = 'COMPLETED')
    ) THEN
      RAISE EXCEPTION 'illegal campaign lifecycle transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.status = 'DRAFT' AND NEW.status = 'REGISTRATION_OPEN' THEN
      IF NEW.published_at IS NULL OR NEW.current_policy_version_id IS NULL OR
         NOT EXISTS (
           SELECT 1 FROM public_core.campaign_publications p
           WHERE p.campaign_id = NEW.id
             AND p.agency = NEW.agency
             AND p.policy_version_id = NEW.current_policy_version_id
             AND p.public_code = NEW.public_code
         ) THEN
        RAISE EXCEPTION 'opening registration requires a durable publication for the selected policy'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD.status = 'REGISTRATION_OPEN' AND NEW.status = 'REGISTRATION_CLOSED' THEN
      IF NEW.registration_closed_at IS NULL THEN
        RAISE EXCEPTION 'registration close timestamp is required'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW.status = 'CANCELLED' THEN
      IF NEW.cancelled_at IS NULL THEN
        RAISE EXCEPTION 'campaign cancellation timestamp is required'
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.status = 'REGISTRATION_OPEN' THEN
        CASE OLD.agency
          WHEN 'RDF' THEN
            EXECUTE 'SELECT EXISTS (SELECT 1 FROM rdf_ops.applications WHERE campaign_id = $1)'
              INTO v_has_application USING OLD.id;
          WHEN 'RNP' THEN
            EXECUTE 'SELECT EXISTS (SELECT 1 FROM rnp_ops.applications WHERE campaign_id = $1)'
              INTO v_has_application USING OLD.id;
          WHEN 'RCS' THEN
            EXECUTE 'SELECT EXISTS (SELECT 1 FROM rcs_ops.applications WHERE campaign_id = $1)'
              INTO v_has_application USING OLD.id;
        END CASE;
        IF v_has_application THEN
          RAISE EXCEPTION 'an open campaign with applications cannot be cancelled'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
  END IF;

  IF NEW.published_at IS DISTINCT FROM OLD.published_at
     AND NOT (OLD.status = 'DRAFT' AND NEW.status = 'REGISTRATION_OPEN') THEN
    RAISE EXCEPTION 'published_at is set only by publication'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.registration_closed_at IS DISTINCT FROM OLD.registration_closed_at
     AND NOT (OLD.status = 'REGISTRATION_OPEN' AND NEW.status = 'REGISTRATION_CLOSED') THEN
    RAISE EXCEPTION 'registration_closed_at is set only by registration closure'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
     AND NOT (NEW.status = 'CANCELLED' AND OLD.status IN ('DRAFT', 'REGISTRATION_OPEN')) THEN
    RAISE EXCEPTION 'cancelled_at is set only by a permitted cancellation'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_campaign_lifecycle_guard ON public_core.recruitment_campaigns;
CREATE TRIGGER trg_campaign_lifecycle_guard
  BEFORE UPDATE ON public_core.recruitment_campaigns
  FOR EACH ROW EXECUTE FUNCTION public_core.guard_campaign_lifecycle_update();

-- A status update cannot commit without the matching append-only history row.
CREATE OR REPLACE FUNCTION public_core.require_campaign_lifecycle_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public_core.campaign_lifecycle_history h
      WHERE h.campaign_id = NEW.id
        AND h.agency = NEW.agency
        AND h.from_status IS NULL
        AND h.to_status = 'DRAFT'
        AND h.actor_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'new campaign requires an append-only initial DRAFT history row'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status AND NOT EXISTS (
    SELECT 1 FROM public_core.campaign_lifecycle_history h
    WHERE h.campaign_id = NEW.id
      AND h.agency = NEW.agency
      AND h.from_status = OLD.status
      AND h.to_status = NEW.status
      AND h.actor_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'campaign lifecycle transition requires an append-only history row'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_campaign_lifecycle_history_required ON public_core.recruitment_campaigns;
CREATE CONSTRAINT TRIGGER trg_campaign_lifecycle_history_required
  AFTER INSERT OR UPDATE ON public_core.recruitment_campaigns
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public_core.require_campaign_lifecycle_history();

-- ── Safe public view RLS and atomic outbox staging ─────────────────────────
-- Policy rows remain private. Public reader sees only safe view columns; the
-- publication table grants it only a publicCode equality key.
-- The existing officer outbox grant remains INSERT-only. Keep its established
-- application-service producer path; allow scheduling-service only for the
-- BUILD-001 session event and its matching agency-bound safe audit envelope.
DROP POLICY IF EXISTS pc_event_outbox_officer_stage ON public_core.event_outbox;
CREATE POLICY pc_event_outbox_officer_stage ON public_core.event_outbox
  FOR INSERT TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer
  WITH CHECK (
    producer = 'application-service'
    OR (
      producer = 'scheduling-service'
      AND payload->>'eventType' = event_type
      AND payload->>'schemaVersion' = '1.0'
      AND payload->>'piiClassification' = 'NONE'
      AND payload ? 'correlationId'
      AND payload ? 'causationId'
      AND (
        (current_user = 'usrp_rdf_officer' AND payload->>'agency' = 'RDF') OR
        (current_user = 'usrp_rnp_officer' AND payload->>'agency' = 'RNP') OR
        (current_user = 'usrp_rcs_officer' AND payload->>'agency' = 'RCS')
      )
      AND (
        event_type = 'CAMPAIGN_SESSION_CONFIGURED'
        OR (
          event_type = 'AUDIT_ENTRY'
          AND payload->>'entityType' = 'CAMPAIGN'
          AND payload->>'action' = 'CAMPAIGN_SESSION_CONFIGURED'
        )
      )
    )
  );

COMMIT;
