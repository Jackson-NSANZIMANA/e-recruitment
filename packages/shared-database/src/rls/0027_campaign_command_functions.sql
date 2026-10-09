-- 0027 — BUILD-001 command-function write boundary.
--
-- The application and scheduling services may read through their existing
-- agency roles, but those roles no longer receive direct campaign/session DML.
-- Writes run only through operation-specific SECURITY DEFINER functions. The
-- private owner is NOLOGIN, has BYPASSRLS, and receives only the campaign,
-- session, outbox-insert, actor-claim, and application-campaign-id privileges
-- needed by these functions. It is not a member of usrp_app or any service role.
--
-- Each public function rechecks the verified officer account/agency_admin role,
-- serializes on campaign first (then coverage head/session), stores the
-- idempotency response, writes authoritative rows, and validates/stages the
-- domain event plus AUDIT_ENTRY in the same transaction. Raw table DML is not
-- granted to usrp_app or the agency officer roles.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usrp_campaign_command_owner') THEN
    CREATE ROLE usrp_campaign_command_owner NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usrp_campaign_admin_provision_owner') THEN
    CREATE ROLE usrp_campaign_admin_provision_owner NOLOGIN BYPASSRLS;
  END IF;
END$$;

-- These are private implementation owners, never service principals. Normalize
-- attributes on re-run, and remove any stale membership in either direction so
-- no login role can SET ROLE into an owner or let an owner inherit a service
-- role's broader table grants.
ALTER ROLE usrp_campaign_command_owner
  WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN BYPASSRLS;
ALTER ROLE usrp_campaign_admin_provision_owner
  WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN BYPASSRLS;
DO $$
DECLARE
  v_membership record;
BEGIN
  FOR v_membership IN
    SELECT granted.rolname AS granted_role, member.rolname AS member_role
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE granted.rolname IN ('usrp_campaign_command_owner', 'usrp_campaign_admin_provision_owner')
       OR member.rolname IN ('usrp_campaign_command_owner', 'usrp_campaign_admin_provision_owner')
  LOOP
    EXECUTE format('REVOKE %I FROM %I', v_membership.granted_role, v_membership.member_role);
  END LOOP;
END$$;

GRANT USAGE ON SCHEMA public_core, rdf_ops, rnp_ops, rcs_ops
  TO usrp_campaign_command_owner;
GRANT USAGE ON SCHEMA public_core TO usrp_campaign_admin_provision_owner;
GRANT CREATE ON SCHEMA public_core
  TO usrp_campaign_command_owner, usrp_campaign_admin_provision_owner;
GRANT SELECT, INSERT ON public_core.officer_accounts
  TO usrp_campaign_admin_provision_owner;
GRANT INSERT ON public_core.event_outbox
  TO usrp_campaign_admin_provision_owner;
GRANT USAGE ON SEQUENCE public_core.event_outbox_id_seq
  TO usrp_campaign_admin_provision_owner;
GRANT SELECT, INSERT, UPDATE ON public_core.recruitment_campaigns,
  public_core.campaign_policy_versions,
  public_core.campaign_publications,
  public_core.campaign_lifecycle_history,
  public_core.campaign_command_requests,
  public_core.campaign_coverage_heads,
  public_core.session_command_requests
  TO usrp_campaign_command_owner;
GRANT SELECT, INSERT ON public_core.campaign_venue_assignments
  TO usrp_campaign_command_owner;
GRANT UPDATE (province, venue_name, exam_date, reporting_time_hour,
              capacity_limit, capacity_decision_code, is_active)
  ON public_core.campaign_venue_assignments TO usrp_campaign_command_owner;
GRANT UPDATE (registered_count) ON public_core.campaign_venue_assignments
  TO usrp_campaign_command_owner;
GRANT INSERT ON public_core.event_outbox TO usrp_campaign_command_owner;
GRANT USAGE ON SEQUENCE public_core.event_outbox_id_seq TO usrp_campaign_command_owner;
-- The relay may mark/quarantine and purge rows, but cannot rewrite the event
-- identity, producer, type, or payload after a command transaction commits.
REVOKE UPDATE ON public_core.event_outbox FROM usrp_system_service;
GRANT UPDATE (published_at, attempts, last_error)
  ON public_core.event_outbox TO usrp_system_service;
GRANT SELECT (officer_id, agency, roles, status)
  ON public_core.officer_accounts TO usrp_campaign_command_owner;
GRANT SELECT (campaign_id) ON rdf_ops.applications, rnp_ops.applications, rcs_ops.applications
  TO usrp_campaign_command_owner;

-- Agency officer roles remain useful for RLS-scoped reads and legacy application
-- workflows, but cannot directly author or mutate the campaign control plane.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public_core.recruitment_campaigns,
  public_core.campaign_policy_versions,
  public_core.campaign_publications,
  public_core.campaign_lifecycle_history,
  public_core.campaign_command_requests,
  public_core.campaign_coverage_heads,
  public_core.session_command_requests,
  public_core.campaign_venue_assignments
  FROM usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;
-- 0026 granted some venue/root UPDATE privileges at column scope. PostgreSQL
-- keeps those independent from table-level ACLs, so revoke the old columns too.
-- The system reservation worker now updates the legacy seat counter only
-- through the two narrow functions below, preserving its conditional row-lock
-- behavior without granting direct session-row DML.
REVOKE UPDATE (registered_count) ON public_core.campaign_venue_assignments
  FROM usrp_system_service;
REVOKE UPDATE (current_policy_version_id, status, published_at,
               registration_closed_at, cancelled_at, updated_at)
  ON public_core.recruitment_campaigns
  FROM usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;
REVOKE UPDATE (district, province, venue_name, exam_date, reporting_time_hour,
               capacity_limit, is_active)
  ON public_core.campaign_venue_assignments
  FROM usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;
REVOKE SELECT ON public_core.campaign_command_requests,
  public_core.session_command_requests
  FROM usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;

-- Keep the existing safe, agency-scoped read paths used by the services. The
-- idempotency ledgers are read only through the admin-authorized replay functions.
GRANT SELECT ON public_core.recruitment_campaigns,
  public_core.campaign_policy_versions,
  public_core.campaign_publications,
  public_core.campaign_lifecycle_history,
  public_core.campaign_coverage_heads,
  public_core.campaign_venue_assignments
  TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;

-- Preserve the legacy application-service outbox lane, but campaign domain
-- and campaign AUDIT_ENTRY rows can now be staged only by command functions.
DROP POLICY IF EXISTS pc_event_outbox_officer_stage ON public_core.event_outbox;
CREATE POLICY pc_event_outbox_officer_stage ON public_core.event_outbox
  FOR INSERT TO usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer
  WITH CHECK (
    producer = 'application-service'
    AND event_type NOT LIKE 'CAMPAIGN_%'
    AND COALESCE(payload->>'eventType', event_type) NOT LIKE 'CAMPAIGN_%'
    AND NOT (
      event_type = 'AUDIT_ENTRY'
      AND (payload->>'entityType' = 'CAMPAIGN' OR payload->>'action' LIKE 'CAMPAIGN_%')
    )
  );

-- Keep the system relay's read/update/delete lane while preventing it from
-- forging campaign domain or campaign AUDIT_ENTRY rows outside the command
-- functions. Slot and other legacy events continue through the existing
-- system-service outbox path.
DROP POLICY IF EXISTS pc_event_outbox_system ON public_core.event_outbox;
DROP POLICY IF EXISTS pc_event_outbox_system_select ON public_core.event_outbox;
DROP POLICY IF EXISTS pc_event_outbox_system_update ON public_core.event_outbox;
DROP POLICY IF EXISTS pc_event_outbox_system_delete ON public_core.event_outbox;
DROP POLICY IF EXISTS pc_event_outbox_system_insert ON public_core.event_outbox;
CREATE POLICY pc_event_outbox_system_select ON public_core.event_outbox
  FOR SELECT TO usrp_system_service USING (true);
CREATE POLICY pc_event_outbox_system_update ON public_core.event_outbox
  FOR UPDATE TO usrp_system_service USING (true) WITH CHECK (true);
CREATE POLICY pc_event_outbox_system_delete ON public_core.event_outbox
  FOR DELETE TO usrp_system_service USING (true);
CREATE POLICY pc_event_outbox_system_insert ON public_core.event_outbox
  FOR INSERT TO usrp_system_service
  WITH CHECK (
    event_type NOT LIKE 'CAMPAIGN_%'
    AND COALESCE(payload->>'eventType', event_type) NOT LIKE 'CAMPAIGN_%'
    AND NOT (
      event_type = 'AUDIT_ENTRY'
      AND (payload->>'entityType' = 'CAMPAIGN' OR payload->>'action' LIKE 'CAMPAIGN_%')
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'campaign_capacity_decision_code_check'
      AND conrelid = 'public_core.campaign_venue_assignments'::regclass
  ) THEN
    ALTER TABLE public_core.campaign_venue_assignments
      ADD CONSTRAINT campaign_capacity_decision_code_check
      CHECK (
        (capacity_decision_code IS NULL OR capacity_decision_code = 'UNBOUNDED_CAPACITY')
        AND (capacity_limit IS NULL OR capacity_decision_code IS NULL)
      );
  END IF;
END$$;

-- Replace the 0026 session guard so the private NOLOGIN command-function owner
-- can perform only the unchanged-configuration registered_count delta used by
-- the two legacy reservation functions. Include the new decision column in the
-- unchanged-row check so a count update cannot smuggle a config mutation.
CREATE OR REPLACE FUNCTION public_core.guard_campaign_session_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_campaign_id uuid;
  v_status public_core.campaign_status;
  v_target_districts jsonb;
  v_exam_start varchar(10);
  v_exam_end varchar(10);
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_user IN ('usrp_system_service', 'usrp_campaign_command_owner')
     AND ROW(NEW.id, NEW.campaign_id, NEW.district, NEW.province, NEW.venue_name,
             NEW.exam_date, NEW.reporting_time_hour, NEW.capacity_limit,
             NEW.capacity_decision_code, NEW.is_active, NEW.created_at)
         IS NOT DISTINCT FROM
         ROW(OLD.id, OLD.campaign_id, OLD.district, OLD.province, OLD.venue_name,
             OLD.exam_date, OLD.reporting_time_hour, OLD.capacity_limit,
             OLD.capacity_decision_code, OLD.is_active, OLD.created_at)
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
  FROM public_core.recruitment_campaigns AS c
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
           NEW.reporting_time_hour, NEW.capacity_limit, NEW.capacity_decision_code,
           NEW.is_active)
       IS DISTINCT FROM
       ROW(OLD.district, OLD.province, OLD.venue_name, OLD.exam_date,
           OLD.reporting_time_hour, OLD.capacity_limit, OLD.capacity_decision_code,
           OLD.is_active) THEN
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
$function$;

-- A policy digest is only independently verifiable if the exact canonical v1
-- UTF-8 bytes survive JSONB storage. New writes populate this nullable column;
-- legacy pre-BUILD-001 campaign/policy behavior is not rewritten.

CREATE OR REPLACE FUNCTION public_core.campaign_private_uuid_v5(
  p_namespace uuid,
  p_name text
)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_digest bytea;
  v_hex text;
BEGIN
  v_digest := public.digest(
    decode(replace(p_namespace::text, '-', ''), 'hex') ||
      convert_to(normalize(p_name, NFC), 'UTF8'),
    'sha1'
  );
  v_digest := set_byte(v_digest, 6, (get_byte(v_digest, 6) & 15) | 80);
  v_digest := set_byte(v_digest, 8, (get_byte(v_digest, 8) & 63) | 128);
  v_hex := encode(substring(v_digest FROM 1 FOR 16), 'hex');
  RETURN (
    substring(v_hex FROM 1 FOR 8) || '-' ||
    substring(v_hex FROM 9 FOR 4) || '-' ||
    substring(v_hex FROM 13 FOR 4) || '-' ||
    substring(v_hex FROM 17 FOR 4) || '-' ||
    substring(v_hex FROM 21 FOR 12)
  )::uuid;
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_private_authorize_admin(
  p_actor_id uuid,
  p_agency public_core.agency
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_agency public_core.agency;
  v_roles text[];
  v_status text;
BEGIN
  IF session_user <> 'usrp_app' THEN
    RAISE EXCEPTION 'campaign commands are available only to the application database login'
      USING ERRCODE = '42501';
  END IF;
  -- The adapter sets this transaction-local value from the already-verified
  -- officer principal. It prevents accidental command-payload substitution,
  -- but is not an independent identity proof: usrp_app can set custom GUCs, so
  -- the authenticated service remains the trust boundary for the human subject.
  IF current_setting('usrp.campaign_actor_id', true) IS DISTINCT FROM p_actor_id::text THEN
    RAISE EXCEPTION 'campaign command actor does not match transaction actor context'
      USING ERRCODE = '42501';
  END IF;
  -- The function owner bypasses RLS, so pin the *invoking database role* to
  -- the requested agency before consulting the active admin account. The app
  -- login is a member of all three officer roles; without this check a bug or
  -- misuse in trusted backend code could SET ROLE RDF and call an RNP command
  -- by supplying an RNP administrator's UUID.
  IF (p_agency = 'RDF' AND current_setting('role', true) IS DISTINCT FROM 'usrp_rdf_officer')
     OR (p_agency = 'RNP' AND current_setting('role', true) IS DISTINCT FROM 'usrp_rnp_officer')
     OR (p_agency = 'RCS' AND current_setting('role', true) IS DISTINCT FROM 'usrp_rcs_officer') THEN
    RAISE EXCEPTION 'campaign DB role does not match the requested agency'
      USING ERRCODE = '42501';
  END IF;

  SELECT oa.agency, oa.roles, oa.status
    INTO v_agency, v_roles, v_status
  FROM public_core.officer_accounts AS oa
  WHERE oa.officer_id = p_actor_id;

  IF NOT FOUND OR v_status <> 'active' OR v_agency IS DISTINCT FROM p_agency
     OR NOT ('agency_admin' = ANY(COALESCE(v_roles, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'campaign command requires an active agency_admin principal'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

-- One-time, operator-run first-admin path. There is deliberately no public HTTP
-- route and no self-service promotion: the trusted operator records the
-- external authorization reference and the database refuses to bootstrap an
-- agency a second time through this path. Account creation and its safe audit
-- envelope commit atomically.
CREATE OR REPLACE FUNCTION public_core.provision_first_campaign_agency_admin(
  p_officer_id uuid,
  p_login_handle text,
  p_credential text,
  p_agency public_core.agency,
  p_operator_reference text,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_event_id uuid;
  v_occurred_at timestamptz := transaction_timestamp();
  v_payload jsonb;
BEGIN
  IF session_user <> 'usrp_app'
     OR current_setting('role', true) IS DISTINCT FROM 'usrp_iam_service' THEN
    RAISE EXCEPTION 'first campaign administrator provisioning is available only through the operator CLI'
      USING ERRCODE = '42501';
  END IF;
  IF p_officer_id IS NULL OR p_agency IS NULL
     OR p_login_handle IS NULL OR length(btrim(p_login_handle)) NOT BETWEEN 1 AND 128
     OR p_credential IS NULL OR p_credential NOT LIKE 'scrypt$%'
     OR p_operator_reference IS NULL OR p_operator_reference !~ '^[A-Za-z0-9._:-]{3,128}$'
     OR p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9._:-]{3,128}$' THEN
    RAISE EXCEPTION 'invalid first administrator provisioning input' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('campaign-admin-bootstrap:' || p_agency::text, 0));
  IF EXISTS (
    SELECT 1 FROM public_core.officer_accounts AS oa
    WHERE oa.agency = p_agency AND 'agency_admin' = ANY(oa.roles)
  ) THEN
    RAISE EXCEPTION 'FIRST_ADMIN_ALREADY_PROVISIONED'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public_core.officer_accounts
    (officer_id, login_handle, credential, agency, roles, status)
  VALUES (p_officer_id, btrim(p_login_handle), p_credential, p_agency,
          ARRAY['agency_admin']::text[], 'active');

  v_event_id := public_core.campaign_private_uuid_v5(
    'bb663e0e-fb15-4a7b-9eaf-2764a6f75cb4'::uuid,
    'first-campaign-agency-admin:' || p_officer_id::text
  );
  v_payload := jsonb_build_object(
    'eventId', v_event_id::text,
    'eventVersion', '1.0',
    'schemaVersion', '1.0',
    'piiClassification', 'NONE',
    'occurredAt', to_char(v_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'correlationId', p_correlation_id,
    'causationId', p_officer_id::text,
    'eventType', 'AUDIT_ENTRY',
    'entityType', 'OFFICER',
    'entityId', p_officer_id::text,
    'action', 'FIRST_CAMPAIGN_AGENCY_ADMIN_PROVISIONED',
    'performedBy', p_operator_reference,
    'agency', p_agency::text,
    'metadata', jsonb_build_object(
      'provisioningMode', 'FIRST_AGENCY_ADMIN',
      'role', 'agency_admin'
    )
  );
  INSERT INTO public_core.event_outbox (event_id, event_type, producer, payload)
  VALUES (v_event_id, 'AUDIT_ENTRY', 'iam-service', v_payload);

  RETURN jsonb_build_object(
    'officerId', p_officer_id,
    'agency', p_agency,
    'roles', jsonb_build_array('agency_admin'),
    'createdAt', v_occurred_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_private_claim_command(
  p_command_id uuid,
  p_actor_id uuid,
  p_agency public_core.agency,
  p_operation text,
  p_idempotency_key uuid,
  p_request_hash text,
  p_resource_id uuid,
  p_response_status integer,
  p_response_body jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_prior public_core.campaign_command_requests%ROWTYPE;
BEGIN
  IF p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR p_idempotency_key IS NULL OR p_response_body IS NULL
     OR jsonb_typeof(p_response_body) <> 'object' THEN
    RAISE EXCEPTION 'invalid campaign command identity or response'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_actor_id::text || ':' || p_operation || ':' || p_idempotency_key::text,
    0
  ));

  SELECT * INTO v_prior
  FROM public_core.campaign_command_requests
  WHERE actor_id = p_actor_id
    AND operation = p_operation
    AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior.agency IS DISTINCT FROM p_agency
       OR v_prior.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'replayed', true,
      'commandId', v_prior.command_id,
      'resourceId', v_prior.resource_id,
      'responseStatus', v_prior.response_status,
      'responseBody', v_prior.response_body,
      'occurredAt', v_prior.created_at
    );
  END IF;

  INSERT INTO public_core.campaign_command_requests
    (command_id, actor_id, agency, operation, idempotency_key, request_hash,
     resource_id, response_status, response_body)
  VALUES (
    p_command_id, p_actor_id, p_agency, p_operation, p_idempotency_key,
    p_request_hash, p_resource_id, p_response_status, p_response_body
  );
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_private_claim_session_command(
  p_command_id uuid,
  p_actor_id uuid,
  p_agency public_core.agency,
  p_operation text,
  p_idempotency_key uuid,
  p_request_hash text,
  p_campaign_id uuid,
  p_response_body jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_prior public_core.session_command_requests%ROWTYPE;
BEGIN
  IF p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR p_idempotency_key IS NULL OR p_response_body IS NULL
     OR jsonb_typeof(p_response_body) <> 'object' THEN
    RAISE EXCEPTION 'invalid session command identity or response'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_actor_id::text || ':' || p_operation || ':' || p_idempotency_key::text,
    0
  ));

  SELECT * INTO v_prior
  FROM public_core.session_command_requests
  WHERE actor_id = p_actor_id
    AND operation = p_operation
    AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior.agency IS DISTINCT FROM p_agency
       OR v_prior.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'replayed', true,
      'commandId', v_prior.command_id,
      'resourceId', v_prior.campaign_id,
      'responseStatus', v_prior.response_status,
      'responseBody', v_prior.response_body,
      'occurredAt', v_prior.created_at
    );
  END IF;

  INSERT INTO public_core.session_command_requests
    (command_id, campaign_id, agency, actor_id, operation, idempotency_key,
     request_hash, response_status, response_body)
  VALUES (
    p_command_id, p_campaign_id, p_agency, p_actor_id, p_operation,
    p_idempotency_key, p_request_hash, 200, p_response_body
  );
  RETURN NULL;
END;
$function$;

-- Match ECMAScript's UTF-16-code-unit sort used by the shared canonical JSON.
-- PostgreSQL's C collation compares UTF-8 bytes instead, which differs for
-- supplementary Unicode characters in venue names.
CREATE OR REPLACE FUNCTION public_core.campaign_private_utf16_sort_key(p_text text)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_result bytea := ''::bytea;
  v_codepoint integer;
  v_adjusted integer;
  v_high integer;
  v_low integer;
  v_index integer;
BEGIN
  FOR v_index IN 1..char_length(p_text) LOOP
    v_codepoint := ascii(substr(p_text, v_index, 1));
    IF v_codepoint <= 65535 THEN
      v_result := v_result || decode(lpad(to_hex(v_codepoint), 4, '0'), 'hex');
    ELSE
      v_adjusted := v_codepoint - 65536;
      v_high := 55296 + (v_adjusted >> 10);
      v_low := 56320 + (v_adjusted & 1023);
      v_result := v_result || decode(lpad(to_hex(v_high), 4, '0'), 'hex')
                            || decode(lpad(to_hex(v_low), 4, '0'), 'hex');
    END IF;
  END LOOP;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_read_command_replay(
  p_actor_id uuid,
  p_agency public_core.agency,
  p_operation text,
  p_idempotency_key uuid,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_prior public_core.campaign_command_requests%ROWTYPE;
BEGIN
  PERFORM public_core.campaign_private_authorize_admin(p_actor_id, p_agency);
  IF p_idempotency_key IS NULL OR p_request_hash IS NULL
     OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid campaign idempotency identity' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_prior
  FROM public_core.campaign_command_requests AS r
  WHERE r.actor_id = p_actor_id
    AND r.operation = p_operation
    AND r.idempotency_key = p_idempotency_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_prior.agency IS DISTINCT FROM p_agency
     OR v_prior.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object(
    'replayed', true,
    'commandId', v_prior.command_id,
    'resourceId', v_prior.resource_id,
    'responseStatus', v_prior.response_status,
    'responseBody', v_prior.response_body,
    'occurredAt', v_prior.created_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_read_session_command_replay(
  p_actor_id uuid,
  p_agency public_core.agency,
  p_operation text,
  p_idempotency_key uuid,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_prior public_core.session_command_requests%ROWTYPE;
BEGIN
  PERFORM public_core.campaign_private_authorize_admin(p_actor_id, p_agency);
  IF p_idempotency_key IS NULL OR p_request_hash IS NULL
     OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid session idempotency identity' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_prior
  FROM public_core.session_command_requests AS r
  WHERE r.actor_id = p_actor_id
    AND r.operation = p_operation
    AND r.idempotency_key = p_idempotency_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_prior.agency IS DISTINCT FROM p_agency
     OR v_prior.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object(
    'replayed', true,
    'commandId', v_prior.command_id,
    'resourceId', v_prior.campaign_id,
    'responseStatus', v_prior.response_status,
    'responseBody', v_prior.response_body,
    'occurredAt', v_prior.created_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_private_actual_coverage_json(
  p_campaign_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT jsonb_build_object(
    'campaignId', p_campaign_id::text,
    'sessions', COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'district', normalize(s.district, NFC),
          'province', normalize(s.province, NFC),
          'venueName', normalize(s.venue_name, NFC),
          'examDate', normalize(s.exam_date, NFC),
          'reportingTimeHour', s.reporting_time_hour,
          'capacityLimit', s.capacity_limit,
          'isActive', s.is_active
        )
        ORDER BY public_core.campaign_private_utf16_sort_key(normalize(s.district, NFC)),
                 public_core.campaign_private_utf16_sort_key(normalize(s.province, NFC)),
                 public_core.campaign_private_utf16_sort_key(normalize(s.exam_date, NFC)),
                 public_core.campaign_private_utf16_sort_key(normalize(s.venue_name, NFC)),
                 s.reporting_time_hour,
                 s.capacity_limit NULLS FIRST,
                 s.is_active
      ),
      '[]'::jsonb
    )
  )
  FROM public_core.campaign_venue_assignments AS s
  WHERE s.campaign_id = p_campaign_id;
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_private_stage_events(
  p_events jsonb,
  p_command_id uuid,
  p_actor_id uuid,
  p_agency public_core.agency,
  p_campaign_id uuid,
  p_public_code text,
  p_correlation_id text,
  p_operation text,
  p_audit_action text,
  p_audit_metadata jsonb,
  p_audit_name_prefix text,
  p_domain_event_type text,
  p_domain_name text,
  p_domain_fact_id text,
  p_domain_fields jsonb,
  p_producer text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_event jsonb;
  v_audit jsonb;
  v_domain jsonb;
  v_audit_id uuid;
  v_domain_id uuid;
  v_audit_count integer;
  v_domain_count integer;
  v_total integer;
  v_field record;
  v_allowed_keys text[];
  v_expected_domain_keys text[];
BEGIN
  IF p_producer IS NULL OR p_producer NOT IN ('application-service', 'scheduling-service') THEN
    RAISE EXCEPTION 'campaign command outbox producer is not allowed' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_events) <> 'array' THEN
    RAISE EXCEPTION 'campaign outbox events must be a JSON array'
      USING ERRCODE = '22023';
  END IF;
  SELECT count(*)::integer,
         count(*) FILTER (WHERE value->>'eventType' = 'AUDIT_ENTRY')::integer,
         count(*) FILTER (WHERE value->>'eventType' = p_domain_event_type)::integer
    INTO v_total, v_audit_count, v_domain_count
  FROM jsonb_array_elements(p_events) AS events(value);
  IF v_audit_count <> 1
     OR (p_domain_event_type IS NULL AND v_domain_count <> 0)
     OR (p_domain_event_type IS NOT NULL AND v_domain_count <> 1)
     OR v_total <> v_audit_count + v_domain_count THEN
    RAISE EXCEPTION 'campaign command must stage exactly one audit and its expected domain event'
      USING ERRCODE = '23514';
  END IF;

  v_audit_id := public_core.campaign_private_uuid_v5(
    'bb663e0e-fb15-4a7b-9eaf-2764a6f75cb4'::uuid,
    p_audit_name_prefix || p_command_id::text
  );
  SELECT value INTO v_audit
  FROM jsonb_array_elements(p_events) AS events(value)
  WHERE value->>'eventType' = 'AUDIT_ENTRY';
  IF jsonb_typeof(v_audit) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'campaign audit event must be an object' USING ERRCODE = '23514';
  END IF;
  v_allowed_keys := ARRAY[
    'eventId', 'eventVersion', 'schemaVersion', 'piiClassification', 'occurredAt',
    'correlationId', 'causationId', 'eventType', 'entityType', 'entityId',
    'action', 'performedBy', 'agency', 'metadata'
  ];
  IF p_producer = 'application-service' THEN
    v_allowed_keys := v_allowed_keys || ARRAY['campaignId', 'publicCode'];
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(v_audit)) <> cardinality(v_allowed_keys)
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(v_audit) AS keys(key)
       WHERE NOT (key = ANY(v_allowed_keys))
     ) THEN
    RAISE EXCEPTION 'campaign audit event contains an unexpected envelope field'
      USING ERRCODE = '23514';
  END IF;

  IF v_audit->>'eventId' IS DISTINCT FROM v_audit_id::text
     OR v_audit->>'eventVersion' IS DISTINCT FROM '1.0'
     OR v_audit->>'schemaVersion' IS DISTINCT FROM '1.0'
     OR v_audit->>'piiClassification' IS DISTINCT FROM 'NONE'
     OR v_audit->>'correlationId' IS DISTINCT FROM p_correlation_id
     OR v_audit->>'causationId' IS DISTINCT FROM p_command_id::text
     OR v_audit->>'entityType' IS DISTINCT FROM 'CAMPAIGN'
     OR v_audit->>'entityId' IS DISTINCT FROM p_campaign_id::text
     OR v_audit->>'action' IS DISTINCT FROM p_audit_action
     OR v_audit->>'performedBy' IS DISTINCT FROM p_actor_id::text
     OR v_audit->>'agency' IS DISTINCT FROM p_agency::text
     OR (p_producer = 'application-service' AND (
       v_audit->>'campaignId' IS DISTINCT FROM p_campaign_id::text
       OR v_audit->>'publicCode' IS DISTINCT FROM p_public_code
     ))
     OR v_audit->'metadata' IS DISTINCT FROM p_audit_metadata THEN
    RAISE EXCEPTION 'campaign audit envelope does not match the authorized command'
      USING ERRCODE = '23514';
  END IF;

  IF p_domain_event_type IS NOT NULL THEN
    v_domain_id := public_core.campaign_private_uuid_v5(
      'c6c2ef80-2ef0-4eeb-b6a4-4f93d5a4ac11'::uuid,
      p_domain_name
    );
    SELECT value INTO v_domain
    FROM jsonb_array_elements(p_events) AS events(value)
    WHERE value->>'eventType' = p_domain_event_type;
    IF jsonb_typeof(v_domain) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'campaign domain event must be an object' USING ERRCODE = '23514';
    END IF;
    v_expected_domain_keys := ARRAY[
      'eventId', 'eventVersion', 'schemaVersion', 'piiClassification', 'occurredAt',
      'correlationId', 'causationId', 'campaignId', 'publicCode', 'agency',
      'eventType', 'factId'
    ];
    CASE p_domain_event_type
      WHEN 'CAMPAIGN_DRAFT_CREATED' THEN
        v_expected_domain_keys := v_expected_domain_keys || ARRAY['createdAt'];
      WHEN 'CAMPAIGN_POLICY_VERSION_CREATED' THEN
        v_expected_domain_keys := v_expected_domain_keys || ARRAY[
          'policyVersionId', 'policyVersionNumber', 'createdAt'
        ];
      WHEN 'CAMPAIGN_PUBLISHED' THEN
        v_expected_domain_keys := v_expected_domain_keys || ARRAY[
          'publicationId', 'policyVersionId', 'policyVersionNumber',
          'coverageVersion', 'coverageHash', 'publishedAt'
        ];
      WHEN 'CAMPAIGN_REGISTRATION_CLOSED' THEN
        v_expected_domain_keys := v_expected_domain_keys || ARRAY['lifecycleHistoryId', 'closedAt'];
      WHEN 'CAMPAIGN_COMPLETED' THEN
        v_expected_domain_keys := v_expected_domain_keys || ARRAY['lifecycleHistoryId', 'completedAt'];
      WHEN 'CAMPAIGN_CANCELLED' THEN
        v_expected_domain_keys := v_expected_domain_keys || ARRAY['lifecycleHistoryId', 'cancelledAt'];
      WHEN 'CAMPAIGN_SESSION_CONFIGURED' THEN
        v_expected_domain_keys := v_expected_domain_keys || ARRAY[
          'district', 'coverageVersion', 'coverageHash', 'configuredAt'
        ];
      ELSE
        RAISE EXCEPTION 'unsupported campaign domain event type' USING ERRCODE = '22023';
    END CASE;
    IF (SELECT count(*) FROM jsonb_object_keys(v_domain)) <> cardinality(v_expected_domain_keys)
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(v_domain) AS keys(key)
         WHERE NOT (key = ANY(v_expected_domain_keys))
       ) THEN
      RAISE EXCEPTION 'campaign domain event contains an unexpected envelope field'
        USING ERRCODE = '23514';
    END IF;
    IF v_domain->>'eventId' IS DISTINCT FROM v_domain_id::text
       OR v_domain->>'factId' IS DISTINCT FROM p_domain_fact_id
       OR v_domain->>'eventVersion' IS DISTINCT FROM '1.0'
       OR v_domain->>'schemaVersion' IS DISTINCT FROM '1.0'
       OR v_domain->>'piiClassification' IS DISTINCT FROM 'NONE'
       OR v_domain->>'occurredAt' IS DISTINCT FROM v_audit->>'occurredAt'
       OR v_domain->>'correlationId' IS DISTINCT FROM p_correlation_id
       OR v_domain->>'causationId' IS DISTINCT FROM p_command_id::text
       OR v_domain->>'campaignId' IS DISTINCT FROM p_campaign_id::text
       OR v_domain->>'publicCode' IS DISTINCT FROM p_public_code
       OR v_domain->>'agency' IS DISTINCT FROM p_agency::text THEN
      RAISE EXCEPTION 'campaign domain event does not match the authorized command'
        USING ERRCODE = '23514';
    END IF;
    FOR v_field IN SELECT key, value FROM jsonb_each(COALESCE(p_domain_fields, '{}'::jsonb)) LOOP
      IF v_domain->v_field.key IS DISTINCT FROM v_field.value THEN
        RAISE EXCEPTION 'campaign domain event field % does not match command state', v_field.key
          USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;

  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events) AS events(value) LOOP
    INSERT INTO public_core.event_outbox (event_id, event_type, producer, payload)
    VALUES (
      (v_event->>'eventId')::uuid,
      v_event->>'eventType',
      p_producer,
      v_event
    );
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_private_district_province(
  p_district text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT province
  FROM (VALUES
    ('NYARUGENGE', 'KIGALI_CITY'), ('KICUKIRO', 'KIGALI_CITY'), ('GASABO', 'KIGALI_CITY'),
    ('GICUMBI', 'NORTHERN_PROVINCE'), ('BURERA', 'NORTHERN_PROVINCE'),
    ('MUSANZE', 'NORTHERN_PROVINCE'), ('GAKENKE', 'NORTHERN_PROVINCE'),
    ('RULINDO', 'NORTHERN_PROVINCE'),
    ('NYAMAGABE', 'SOUTHERN_PROVINCE'), ('NYARUGURU', 'SOUTHERN_PROVINCE'),
    ('GISAGARA', 'SOUTHERN_PROVINCE'), ('HUYE', 'SOUTHERN_PROVINCE'),
    ('NYANZA', 'SOUTHERN_PROVINCE'), ('RUHANGO', 'SOUTHERN_PROVINCE'),
    ('MUHANGA', 'SOUTHERN_PROVINCE'), ('KAMONYI', 'SOUTHERN_PROVINCE'),
    ('KIREHE', 'EASTERN_PROVINCE'), ('NGOMA', 'EASTERN_PROVINCE'),
    ('NYAGATARE', 'EASTERN_PROVINCE'), ('GATSIBO', 'EASTERN_PROVINCE'),
    ('KAYONZA', 'EASTERN_PROVINCE'), ('RWAMAGANA', 'EASTERN_PROVINCE'),
    ('BUGESERA', 'EASTERN_PROVINCE'),
    ('RUSIZI', 'WESTERN_PROVINCE'), ('NYAMASHEKE', 'WESTERN_PROVINCE'),
    ('KARONGI', 'WESTERN_PROVINCE'), ('RUTSIRO', 'WESTERN_PROVINCE'),
    ('RUBAVU', 'WESTERN_PROVINCE'), ('NYABIHU', 'WESTERN_PROVINCE'),
    ('NGORORERO', 'WESTERN_PROVINCE')
  ) AS geography(district, province)
  WHERE district = p_district;
$function$;

-- Read/lock functions retain the established campaign -> coverage-head order.
-- They return only the fields needed by the service's validation layer.
CREATE OR REPLACE FUNCTION public_core.campaign_lock_for_command(
  p_actor_id uuid,
  p_agency public_core.agency,
  p_public_code text
)
RETURNS TABLE (
  id uuid,
  public_code varchar(64),
  agency public_core.agency,
  status public_core.campaign_status,
  target_categories text,
  target_districts jsonb,
  examination_start_date varchar(10),
  examination_end_date varchar(10),
  current_policy_version_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM public_core.campaign_private_authorize_admin(p_actor_id, p_agency);
  RETURN QUERY
    SELECT c.id, c.public_code, c.agency, c.status, c.target_categories,
           c.target_districts, c.examination_start_date, c.examination_end_date,
           c.current_policy_version_id
    FROM public_core.recruitment_campaigns AS c
    WHERE c.public_code = p_public_code AND c.agency = p_agency
    FOR UPDATE;
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_lock_coverage_head(
  p_actor_id uuid,
  p_agency public_core.agency,
  p_campaign_id uuid
)
RETURNS TABLE (coverage_version integer, coverage_hash varchar(64))
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM public_core.campaign_private_authorize_admin(p_actor_id, p_agency);
  PERFORM 1
  FROM public_core.recruitment_campaigns AS c
  WHERE c.id = p_campaign_id AND c.agency = p_agency
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY
    SELECT h.coverage_version, h.coverage_hash
    FROM public_core.campaign_coverage_heads AS h
    WHERE h.campaign_id = p_campaign_id AND h.agency = p_agency
    FOR UPDATE;
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_private_write_history(
  p_campaign_id uuid,
  p_agency public_core.agency,
  p_from_status public_core.campaign_status,
  p_to_status public_core.campaign_status,
  p_actor_id uuid,
  p_correlation_id text,
  p_occurred_at timestamptz,
  p_history_id uuid
)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  INSERT INTO public_core.campaign_lifecycle_history
    (id, campaign_id, agency, from_status, to_status, actor_id, correlation_id, occurred_at)
  VALUES
    (p_history_id, p_campaign_id, p_agency, p_from_status, p_to_status,
     p_actor_id, p_correlation_id, p_occurred_at)
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_write_draft(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_actor uuid := (p_command->>'actorId')::uuid;
  v_agency public_core.agency := (p_command->>'agency')::public_core.agency;
  v_command_id uuid := (p_command->>'commandId')::uuid;
  v_campaign_id uuid := (p_command->>'campaignId')::uuid;
  v_draft jsonb := p_command->'draft';
  v_occurred_at timestamptz := (p_command->>'occurredAt')::timestamptz;
  v_replay jsonb;
  v_history_id uuid := gen_random_uuid();
  v_code text := p_command->>'publicCode';
  v_audit_metadata jsonb;
BEGIN
  PERFORM public_core.campaign_private_authorize_admin(v_actor, v_agency);
  IF p_command->>'operation' IS DISTINCT FROM 'createCampaignDraft'
     OR v_draft IS NULL OR jsonb_typeof(v_draft) <> 'object'
     OR v_code IS DISTINCT FROM v_draft->>'publicCode'
     OR v_command_id IS NULL OR v_campaign_id IS NULL
     OR p_command->>'requestHash' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid draft command payload' USING ERRCODE = '22023';
  END IF;

  v_replay := public_core.campaign_private_claim_command(
    v_command_id, v_actor, v_agency, 'createCampaignDraft',
    (p_command->>'idempotencyKey')::uuid, p_command->>'requestHash',
    v_campaign_id, (p_command->>'responseStatus')::integer,
    p_command->'responseBody'
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  IF v_code !~ '^[A-Z0-9][A-Z0-9-]{2,63}$'
     OR v_code LIKE 'LEGACY-%'
     OR length(v_draft->>'campaignLabel') NOT BETWEEN 1 AND 50
     OR jsonb_typeof(v_draft->'targetCategories') <> 'array'
     OR jsonb_array_length(v_draft->'targetCategories') = 0
     OR jsonb_typeof(v_draft->'targetDistricts') <> 'array'
     OR jsonb_array_length(v_draft->'targetDistricts') = 0 THEN
    RAISE EXCEPTION 'invalid draft business fields' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public_core.recruitment_campaigns
    (id, campaign_label, agency, public_code, status, target_categories,
     target_districts, registration_opens_at, registration_closes_at,
     examination_start_date, examination_end_date, examination_reporting_hour,
     allows_walk_in, target_intake_count, contact_phone_numbers, contact_website,
     published_at, created_at, updated_at)
  VALUES (
    v_campaign_id,
    v_draft->>'campaignLabel',
    v_agency,
    v_code,
    'DRAFT',
    (v_draft->'targetCategories')::text,
    v_draft->'targetDistricts',
    (v_draft->>'registrationOpensAt')::timestamptz,
    (v_draft->>'registrationClosesAt')::timestamptz,
    v_draft->>'examinationStartDate',
    v_draft->>'examinationEndDate',
    (v_draft->>'examinationReportingHour')::integer,
    (v_draft->>'allowsWalkIn')::boolean,
    NULLIF(v_draft->>'targetIntakeCount', '')::integer,
    CASE WHEN v_draft ? 'contactPhoneNumbers' THEN (v_draft->'contactPhoneNumbers')::text ELSE NULL END,
    v_draft->>'contactWebsite',
    NULL,
    v_occurred_at,
    v_occurred_at
  );
  PERFORM public_core.campaign_private_write_history(
    v_campaign_id, v_agency, NULL, 'DRAFT', v_actor,
    p_command->>'correlationId', v_occurred_at, v_history_id
  );

  v_audit_metadata := jsonb_build_object('publicCode', v_code, 'operation', 'CREATE_DRAFT');
  PERFORM public_core.campaign_private_stage_events(
    p_command->'events', v_command_id, v_actor, v_agency, v_campaign_id,
    v_code, p_command->>'correlationId', 'CREATE_DRAFT', 'CAMPAIGN_DRAFT_CREATED',
    v_audit_metadata, 'campaign-command:', 'CAMPAIGN_DRAFT_CREATED',
    'campaign-draft-created:' || v_campaign_id::text, v_campaign_id::text,
    jsonb_build_object('createdAt', p_command->'occurredAt'), 'application-service'
  );
  RETURN jsonb_build_object('replayed', false, 'commandId', v_command_id,
    'resourceId', v_campaign_id, 'responseStatus', (p_command->>'responseStatus')::integer,
    'responseBody', p_command->'responseBody', 'occurredAt', v_occurred_at);
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_write_policy_version(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_actor uuid := (p_command->>'actorId')::uuid;
  v_agency public_core.agency := (p_command->>'agency')::public_core.agency;
  v_campaign_id uuid := (p_command->>'campaignId')::uuid;
  v_command_id uuid := (p_command->>'commandId')::uuid;
  v_policy_id uuid := (p_command->>'policyVersionId')::uuid;
  v_public_code text := p_command->>'publicCode';
  v_operation text := 'createCampaignPolicyVersion';
  v_replay jsonb;
  v_campaign public_core.recruitment_campaigns%ROWTYPE;
  v_policy jsonb := p_command->'policy';
  v_version integer;
  v_occurred_at timestamptz := (p_command->>'occurredAt')::timestamptz;
  v_canonical text := p_command->>'canonicalPolicyJson';
  v_policy_hash text := p_command->>'policyHash';
  v_metadata jsonb;
BEGIN
  PERFORM public_core.campaign_private_authorize_admin(v_actor, v_agency);
  SELECT * INTO v_campaign
  FROM public_core.recruitment_campaigns AS c
  WHERE c.id = v_campaign_id AND c.agency = v_agency AND c.public_code = v_public_code
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CAMPAIGN_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;

  v_replay := public_core.campaign_private_claim_command(
    v_command_id, v_actor, v_agency, v_operation,
    (p_command->>'idempotencyKey')::uuid, p_command->>'requestHash',
    v_campaign_id, (p_command->>'responseStatus')::integer,
    p_command->'responseBody'
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  IF v_campaign.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'INVALID_STATE' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(v_policy) <> 'object'
     OR jsonb_typeof(v_policy->'policyDocument') <> 'object'
     OR v_canonical IS NULL OR v_policy_hash !~ '^[0-9a-f]{64}$'
     OR encode(public.digest(convert_to(v_canonical, 'UTF8'), 'sha256'), 'hex') <> v_policy_hash
     OR v_canonical::jsonb IS DISTINCT FROM jsonb_build_object(
       'legalBasisCode', v_policy->'legalBasisCode',
       'legalBasisReference', v_policy->'legalBasisReference',
       'policyDocument', v_policy->'policyDocument'
     ) THEN
    RAISE EXCEPTION 'POLICY_HASH_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (v_campaign.target_categories::jsonb @> (
       SELECT jsonb_agg(to_jsonb(k)) FROM jsonb_object_keys(v_policy->'policyDocument') AS keys(k)
     )) OR NOT ((v_campaign.target_categories::jsonb) <@ (
       SELECT jsonb_agg(to_jsonb(k)) FROM jsonb_object_keys(v_policy->'policyDocument') AS keys(k)
     )) THEN
    RAISE EXCEPTION 'POLICY_CATEGORY_COVERAGE_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(max(p.version_number), 0) + 1 INTO v_version
  FROM public_core.campaign_policy_versions AS p
  WHERE p.campaign_id = v_campaign_id AND p.agency = v_agency;
  IF v_version <> (p_command->>'policyVersionNumber')::integer THEN
    RAISE EXCEPTION 'POLICY_VERSION_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public_core.campaign_policy_versions
    (id, campaign_id, agency, version_number, policy_document,
     canonical_policy_json, policy_hash, hash_version, legal_basis_code,
     legal_basis_reference, created_by, created_at)
  VALUES (
    v_policy_id, v_campaign_id, v_agency, v_version,
    v_policy->'policyDocument', v_canonical, v_policy_hash, 1,
    v_policy->>'legalBasisCode', v_policy->>'legalBasisReference', v_actor, v_occurred_at
  );
  UPDATE public_core.recruitment_campaigns
  SET current_policy_version_id = v_policy_id, updated_at = v_occurred_at
  WHERE id = v_campaign_id AND agency = v_agency;

  v_metadata := jsonb_build_object('publicCode', v_public_code, 'operation', 'CREATE_POLICY_VERSION',
    'policyVersionNumber', v_version);
  PERFORM public_core.campaign_private_stage_events(
    p_command->'events', v_command_id, v_actor, v_agency, v_campaign_id,
    v_public_code, p_command->>'correlationId', 'CREATE_POLICY_VERSION',
    'CAMPAIGN_POLICY_VERSION_CREATED', v_metadata, 'campaign-command:',
    'CAMPAIGN_POLICY_VERSION_CREATED', 'campaign-policy-version-created:' || v_policy_id::text,
    v_policy_id::text,
    jsonb_build_object('policyVersionId', v_policy_id::text,
                       'policyVersionNumber', v_version,
                       'createdAt', p_command->'occurredAt'),
    'application-service'
  );
  RETURN jsonb_build_object('replayed', false, 'commandId', v_command_id,
    'resourceId', v_campaign_id, 'responseStatus', (p_command->>'responseStatus')::integer,
    'responseBody', p_command->'responseBody', 'occurredAt', v_occurred_at);
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_write_publication(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_actor uuid := (p_command->>'actorId')::uuid;
  v_agency public_core.agency := (p_command->>'agency')::public_core.agency;
  v_campaign_id uuid := (p_command->>'campaignId')::uuid;
  v_command_id uuid := (p_command->>'commandId')::uuid;
  v_public_code text := p_command->>'publicCode';
  v_operation text := 'publishCampaign';
  v_replay jsonb;
  v_campaign public_core.recruitment_campaigns%ROWTYPE;
  v_head public_core.campaign_coverage_heads%ROWTYPE;
  v_policy public_core.campaign_policy_versions%ROWTYPE;
  v_actual jsonb;
  v_canonical text := p_command->>'coverageCanonicalJson';
  v_hash text := p_command->>'coverageHash';
  v_version integer := (p_command->>'coverageVersion')::integer;
  v_publication_id uuid := (p_command->>'publicationId')::uuid;
  v_publication_event_id uuid := (p_command->>'publicationEventId')::uuid;
  v_history_id uuid := (p_command->>'historyId')::uuid;
  v_occurred_at timestamptz := (p_command->>'occurredAt')::timestamptz;
  v_target_count integer;
  v_session_count integer;
  v_metadata jsonb;
BEGIN
  PERFORM public_core.campaign_private_authorize_admin(v_actor, v_agency);
  SELECT * INTO v_campaign
  FROM public_core.recruitment_campaigns AS c
  WHERE c.id = v_campaign_id AND c.agency = v_agency AND c.public_code = v_public_code
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CAMPAIGN_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;

  -- Required serialization order: campaign root, coverage head, persisted sessions.
  v_replay := public_core.campaign_private_claim_command(
    v_command_id, v_actor, v_agency, v_operation,
    (p_command->>'idempotencyKey')::uuid, p_command->>'requestHash',
    v_campaign_id, (p_command->>'responseStatus')::integer,
    p_command->'responseBody'
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF v_campaign.status <> 'DRAFT' OR v_campaign.current_policy_version_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_STATE_OR_POLICY_NOT_SET' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_head
  FROM public_core.campaign_coverage_heads AS h
  WHERE h.campaign_id = v_campaign_id AND h.agency = v_agency
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INCOMPLETE_COVERAGE' USING ERRCODE = 'P0001'; END IF;

  v_actual := public_core.campaign_private_actual_coverage_json(v_campaign_id);
  IF v_canonical IS NULL OR v_hash !~ '^[0-9a-f]{64}$'
     OR encode(public.digest(convert_to(v_canonical, 'UTF8'), 'sha256'), 'hex') <> v_hash
     OR v_canonical::jsonb IS DISTINCT FROM v_actual
     OR v_head.coverage_version <> v_version OR v_head.coverage_hash <> v_hash
     OR v_version < 1 THEN
    RAISE EXCEPTION 'STALE_COVERAGE' USING ERRCODE = 'P0001';
  END IF;

  SELECT jsonb_array_length(v_campaign.target_districts)::integer INTO v_target_count;
  SELECT count(*)::integer INTO v_session_count
  FROM public_core.campaign_venue_assignments AS s
  WHERE s.campaign_id = v_campaign_id;
  IF v_target_count IS NULL OR v_target_count = 0 OR v_session_count <> v_target_count
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(v_campaign.target_districts) AS d(district)
       WHERE NOT EXISTS (
         SELECT 1 FROM public_core.campaign_venue_assignments AS s
         WHERE s.campaign_id = v_campaign_id AND s.district = d.district
       )
     )
     OR EXISTS (
       SELECT 1 FROM public_core.campaign_venue_assignments AS s
       WHERE s.campaign_id = v_campaign_id
         AND (NOT s.is_active OR s.registered_count <> 0
           OR s.exam_date < v_campaign.examination_start_date
           OR s.exam_date > v_campaign.examination_end_date
           OR s.reporting_time_hour NOT BETWEEN 0 AND 23
           OR public_core.campaign_private_district_province(s.district) IS DISTINCT FROM s.province
           OR (s.capacity_limit IS NULL AND s.capacity_decision_code IS DISTINCT FROM 'UNBOUNDED_CAPACITY')
           OR (s.capacity_limit IS NOT NULL AND s.capacity_limit <= 0))
     ) THEN
    RAISE EXCEPTION 'INCOMPLETE_OR_INVALID_COVERAGE' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_policy
  FROM public_core.campaign_policy_versions AS p
  WHERE p.id = v_campaign.current_policy_version_id
    AND p.campaign_id = v_campaign_id AND p.agency = v_agency;
  IF NOT FOUND OR v_policy.hash_version <> 1 OR v_policy.canonical_policy_json IS NULL
     OR encode(public.digest(convert_to(v_policy.canonical_policy_json, 'UTF8'), 'sha256'), 'hex') <> v_policy.policy_hash
     OR v_policy.canonical_policy_json::jsonb IS DISTINCT FROM jsonb_build_object(
       'legalBasisCode', v_policy.legal_basis_code,
       'legalBasisReference', v_policy.legal_basis_reference,
       'policyDocument', v_policy.policy_document
     ) THEN
    RAISE EXCEPTION 'POLICY_HASH_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  IF v_publication_event_id IS DISTINCT FROM public_core.campaign_private_uuid_v5(
       'c6c2ef80-2ef0-4eeb-b6a4-4f93d5a4ac11'::uuid,
       'campaign-published:' || v_publication_id::text
     ) THEN
    RAISE EXCEPTION 'INVALID_PUBLICATION_EVENT_ID' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public_core.campaign_publications
    (id, campaign_id, agency, public_code, policy_version_id,
     coverage_version, coverage_hash, publication_event_id, published_by, published_at)
  VALUES (
    v_publication_id, v_campaign_id, v_agency, v_public_code,
    v_policy.id, v_version, v_hash, v_publication_event_id, v_actor, v_occurred_at
  );
  PERFORM public_core.campaign_private_write_history(
    v_campaign_id, v_agency, 'DRAFT', 'REGISTRATION_OPEN', v_actor,
    p_command->>'correlationId', v_occurred_at, v_history_id
  );
  UPDATE public_core.recruitment_campaigns
  SET status = 'REGISTRATION_OPEN', published_at = v_occurred_at, updated_at = v_occurred_at
  WHERE id = v_campaign_id AND agency = v_agency;

  v_metadata := jsonb_build_object(
    'publicCode', v_public_code, 'operation', 'PUBLISH',
    'publicationId', v_publication_id::text,
    'policyVersionNumber', v_policy.version_number,
    'coverageVersion', v_version
  );
  PERFORM public_core.campaign_private_stage_events(
    p_command->'events', v_command_id, v_actor, v_agency, v_campaign_id,
    v_public_code, p_command->>'correlationId', 'PUBLISH', 'CAMPAIGN_PUBLISHED',
    v_metadata, 'campaign-command:', 'CAMPAIGN_PUBLISHED',
    'campaign-published:' || v_publication_id::text, v_publication_id::text,
    jsonb_build_object(
      'publicationId', v_publication_id::text,
      'policyVersionId', v_policy.id::text,
      'policyVersionNumber', v_policy.version_number,
      'coverageVersion', v_version,
      'coverageHash', v_hash,
      'publishedAt', p_command->'occurredAt'
    ), 'application-service'
  );
  RETURN jsonb_build_object('replayed', false, 'commandId', v_command_id,
    'resourceId', v_campaign_id, 'responseStatus', (p_command->>'responseStatus')::integer,
    'responseBody', p_command->'responseBody', 'occurredAt', v_occurred_at);
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_private_write_lifecycle(
  p_command jsonb,
  p_expected_operation text,
  p_expected_action text,
  p_target_status public_core.campaign_status
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_actor uuid := (p_command->>'actorId')::uuid;
  v_agency public_core.agency := (p_command->>'agency')::public_core.agency;
  v_campaign_id uuid := (p_command->>'campaignId')::uuid;
  v_command_id uuid := (p_command->>'commandId')::uuid;
  v_public_code text := p_command->>'publicCode';
  v_operation text := p_expected_operation;
  v_replay jsonb;
  v_campaign public_core.recruitment_campaigns%ROWTYPE;
  v_from public_core.campaign_status;
  v_history_id uuid := (p_command->>'historyId')::uuid;
  v_occurred_at timestamptz := (p_command->>'occurredAt')::timestamptz;
  v_has_application boolean := false;
  v_metadata jsonb;
  v_domain_type text;
  v_domain_name text;
  v_fact_id text;
  v_domain_fields jsonb;
BEGIN
  PERFORM public_core.campaign_private_authorize_admin(v_actor, v_agency);
  SELECT * INTO v_campaign
  FROM public_core.recruitment_campaigns AS c
  WHERE c.id = v_campaign_id AND c.agency = v_agency AND c.public_code = v_public_code
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CAMPAIGN_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;

  v_replay := public_core.campaign_private_claim_command(
    v_command_id, v_actor, v_agency, v_operation,
    (p_command->>'idempotencyKey')::uuid, p_command->>'requestHash',
    v_campaign_id, (p_command->>'responseStatus')::integer,
    p_command->'responseBody'
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_from := v_campaign.status;
  IF NOT (
       (p_target_status = 'REGISTRATION_CLOSED' AND v_from = 'REGISTRATION_OPEN') OR
       (p_target_status = 'COMPLETED' AND v_from = 'REGISTRATION_CLOSED') OR
       (p_target_status = 'CANCELLED' AND v_from IN ('DRAFT', 'REGISTRATION_OPEN'))
     ) THEN
    RAISE EXCEPTION 'INVALID_STATE' USING ERRCODE = 'P0001';
  END IF;
  IF p_target_status = 'CANCELLED' AND v_from = 'REGISTRATION_OPEN' THEN
    CASE v_agency
      WHEN 'RDF' THEN SELECT EXISTS (SELECT 1 FROM rdf_ops.applications WHERE campaign_id = v_campaign_id) INTO v_has_application;
      WHEN 'RNP' THEN SELECT EXISTS (SELECT 1 FROM rnp_ops.applications WHERE campaign_id = v_campaign_id) INTO v_has_application;
      WHEN 'RCS' THEN SELECT EXISTS (SELECT 1 FROM rcs_ops.applications WHERE campaign_id = v_campaign_id) INTO v_has_application;
    END CASE;
    IF v_has_application THEN RAISE EXCEPTION 'CANCELLATION_HAS_APPLICATIONS' USING ERRCODE = 'P0001'; END IF;
  END IF;

  PERFORM public_core.campaign_private_write_history(
    v_campaign_id, v_agency, v_from, p_target_status, v_actor,
    p_command->>'correlationId', v_occurred_at, v_history_id
  );
  UPDATE public_core.recruitment_campaigns
  SET status = p_target_status,
      registration_closed_at = CASE WHEN p_target_status = 'REGISTRATION_CLOSED' THEN v_occurred_at ELSE registration_closed_at END,
      cancelled_at = CASE WHEN p_target_status = 'CANCELLED' THEN v_occurred_at ELSE cancelled_at END,
      updated_at = v_occurred_at
  WHERE id = v_campaign_id AND agency = v_agency;

  CASE p_target_status
    WHEN 'REGISTRATION_CLOSED' THEN
      v_domain_type := 'CAMPAIGN_REGISTRATION_CLOSED';
      v_domain_name := 'registration-closed:' || v_history_id::text;
      v_fact_id := v_history_id::text;
      v_domain_fields := jsonb_build_object('lifecycleHistoryId', v_history_id::text,
                                            'closedAt', p_command->'occurredAt');
    WHEN 'COMPLETED' THEN
      v_domain_type := 'CAMPAIGN_COMPLETED';
      v_domain_name := 'completed:' || v_history_id::text;
      v_fact_id := v_history_id::text;
      v_domain_fields := jsonb_build_object('lifecycleHistoryId', v_history_id::text,
                                            'completedAt', p_command->'occurredAt');
    WHEN 'CANCELLED' THEN
      v_domain_type := 'CAMPAIGN_CANCELLED';
      v_domain_name := 'cancelled:' || v_history_id::text;
      v_fact_id := v_history_id::text;
      v_domain_fields := jsonb_build_object('lifecycleHistoryId', v_history_id::text,
                                            'cancelledAt', p_command->'occurredAt');
    ELSE RAISE EXCEPTION 'unsupported campaign lifecycle target' USING ERRCODE = '22023';
  END CASE;

  IF v_operation = 'closeCampaignRegistration' THEN
    v_metadata := jsonb_build_object('publicCode', v_public_code, 'operation', 'CLOSE_REGISTRATION',
                                     'lifecycleHistoryId', v_history_id::text);
  ELSIF v_operation = 'completeCampaign' THEN
    v_metadata := jsonb_build_object('publicCode', v_public_code, 'operation', 'COMPLETE',
                                     'lifecycleHistoryId', v_history_id::text);
  ELSE
    v_metadata := jsonb_build_object('publicCode', v_public_code, 'operation', 'CANCEL',
                                     'lifecycleHistoryId', v_history_id::text,
                                     'fromStatus', v_from::text);
  END IF;
  IF p_command->>'operation' IS DISTINCT FROM v_operation
     OR p_command->>'auditAction' IS DISTINCT FROM p_expected_action THEN
    RAISE EXCEPTION 'invalid lifecycle command operation' USING ERRCODE = '22023';
  END IF;
  PERFORM public_core.campaign_private_stage_events(
    p_command->'events', v_command_id, v_actor, v_agency, v_campaign_id,
    v_public_code, p_command->>'correlationId', p_command->>'operation',
    p_expected_action, v_metadata, 'campaign-command:', v_domain_type,
    v_domain_name, v_fact_id, v_domain_fields, 'application-service'
  );
  RETURN jsonb_build_object('replayed', false, 'commandId', v_command_id,
    'resourceId', v_campaign_id, 'responseStatus', (p_command->>'responseStatus')::integer,
    'responseBody', p_command->'responseBody', 'occurredAt', v_occurred_at);
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_close_registration(p_command jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  RETURN public_core.campaign_private_write_lifecycle(
    p_command, 'closeCampaignRegistration', 'CAMPAIGN_REGISTRATION_CLOSED', 'REGISTRATION_CLOSED'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_complete(p_command jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  RETURN public_core.campaign_private_write_lifecycle(
    p_command, 'completeCampaign', 'CAMPAIGN_COMPLETED', 'COMPLETED'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.campaign_cancel(p_command jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  RETURN public_core.campaign_private_write_lifecycle(
    p_command, 'cancelCampaign', 'CAMPAIGN_CANCELLED', 'CANCELLED'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.scheduling_configure_campaign_session(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_actor uuid := (p_command->>'actorId')::uuid;
  v_agency public_core.agency := (p_command->>'agency')::public_core.agency;
  v_campaign_id uuid := (p_command->>'campaignId')::uuid;
  v_command_id uuid := (p_command->>'commandId')::uuid;
  v_public_code text := p_command->>'publicCode';
  v_session jsonb := p_command->'session';
  v_replay jsonb;
  v_campaign public_core.recruitment_campaigns%ROWTYPE;
  v_head public_core.campaign_coverage_heads%ROWTYPE;
  v_has_head boolean := false;
  v_existing public_core.campaign_venue_assignments%ROWTYPE;
  v_has_existing boolean := false;
  v_current_actual jsonb;
  v_expected_actual jsonb;
  v_current_canonical text := p_command->>'currentCoverageCanonicalJson';
  v_current_hash text := p_command->>'currentCoverageHash';
  v_expected_canonical text := p_command->>'coverageCanonicalJson';
  v_expected_hash text := p_command->>'coverageHash';
  v_current_version integer := COALESCE((p_command->>'currentCoverageVersion')::integer, 0);
  v_next_version integer;
  v_changed boolean := false;
  v_coverage_changed boolean := false;
  v_occurred_at timestamptz := (p_command->>'occurredAt')::timestamptz;
  v_response jsonb := p_command->'responseBody';
  v_session_id uuid := (p_command->>'sessionId')::uuid;
  v_metadata jsonb;
  v_domain_type text;
  v_domain_name text;
  v_fact_id text;
  v_domain_fields jsonb;
BEGIN
  PERFORM public_core.campaign_private_authorize_admin(v_actor, v_agency);
  SELECT * INTO v_campaign
  FROM public_core.recruitment_campaigns AS c
  WHERE c.id = v_campaign_id AND c.agency = v_agency AND c.public_code = v_public_code
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CAMPAIGN_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;

  -- Session writes acquire the campaign lock, then the coverage-head lock, then
  -- reread/lock the session rows. This is the same order as publication.
  SELECT * INTO v_head
  FROM public_core.campaign_coverage_heads AS h
  WHERE h.campaign_id = v_campaign_id AND h.agency = v_agency
  FOR UPDATE;
  v_has_head := FOUND;

  v_replay := public_core.campaign_private_claim_session_command(
    v_command_id, v_actor, v_agency, 'configureCampaignSession',
    (p_command->>'idempotencyKey')::uuid, p_command->>'requestHash',
    v_campaign_id, v_response
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  IF p_command->>'operation' IS DISTINCT FROM 'configureCampaignSession'
     OR v_campaign.status <> 'DRAFT'
     OR jsonb_typeof(v_session) <> 'object'
     OR v_session->>'publicCode' IS DISTINCT FROM v_public_code
     OR v_campaign.target_districts IS NULL
     OR NOT (v_campaign.target_districts @> jsonb_build_array(v_session->>'district'))
     OR (v_session->>'examDate')::varchar(10) < v_campaign.examination_start_date
     OR (v_session->>'examDate')::varchar(10) > v_campaign.examination_end_date
     OR public_core.campaign_private_district_province(v_session->>'district') IS DISTINCT FROM v_session->>'province'
     OR (v_session->>'reportingTimeHour')::integer NOT BETWEEN 0 AND 23
     OR ((v_session->>'capacityLimit') IS NULL AND v_session->>'capacityDecisionCode' IS DISTINCT FROM 'UNBOUNDED_CAPACITY')
     OR ((v_session->>'capacityLimit') IS NOT NULL AND
          ((v_session->>'capacityLimit')::integer <= 0 OR v_session->>'capacityDecisionCode' IS NOT NULL)) THEN
    RAISE EXCEPTION 'INVALID_SESSION_CONFIGURATION' USING ERRCODE = 'P0001';
  END IF;

  v_current_actual := public_core.campaign_private_actual_coverage_json(v_campaign_id);
  IF v_current_canonical IS NULL OR v_current_hash !~ '^[0-9a-f]{64}$'
     OR encode(public.digest(convert_to(v_current_canonical, 'UTF8'), 'sha256'), 'hex') <> v_current_hash
     OR v_current_canonical::jsonb IS DISTINCT FROM v_current_actual THEN
    RAISE EXCEPTION 'STALE_COVERAGE' USING ERRCODE = 'P0001';
  END IF;
  IF v_has_head THEN
    IF v_head.coverage_version <> v_current_version OR v_head.coverage_hash <> v_current_hash THEN
      RAISE EXCEPTION 'STALE_COVERAGE' USING ERRCODE = 'P0001';
    END IF;
  ELSIF v_current_version <> 0 THEN
    RAISE EXCEPTION 'STALE_COVERAGE' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_existing
  FROM public_core.campaign_venue_assignments AS s
  WHERE s.campaign_id = v_campaign_id AND s.district = v_session->>'district'
  FOR UPDATE;
  v_has_existing := FOUND;
  IF v_has_existing THEN
    v_changed := ROW(
      v_existing.province, v_existing.venue_name, v_existing.exam_date,
      v_existing.reporting_time_hour, v_existing.capacity_limit,
      v_existing.capacity_decision_code, v_existing.is_active
    ) IS DISTINCT FROM ROW(
      v_session->>'province', v_session->>'venueName', v_session->>'examDate',
      (v_session->>'reportingTimeHour')::integer,
      NULLIF(v_session->>'capacityLimit', '')::integer,
      v_session->>'capacityDecisionCode',
      (v_session->>'isActive')::boolean
    );
    IF v_changed AND v_existing.registered_count > 0 THEN
      RAISE EXCEPTION 'SESSION_ALREADY_RESERVED' USING ERRCODE = 'P0001';
    END IF;
    v_coverage_changed := ROW(
      v_existing.district, v_existing.province, v_existing.venue_name, v_existing.exam_date,
      v_existing.reporting_time_hour, v_existing.capacity_limit, v_existing.is_active
    ) IS DISTINCT FROM ROW(
      v_session->>'district', v_session->>'province', v_session->>'venueName',
      v_session->>'examDate', (v_session->>'reportingTimeHour')::integer,
      NULLIF(v_session->>'capacityLimit', '')::integer, (v_session->>'isActive')::boolean
    );
  ELSE
    v_changed := true;
    v_coverage_changed := true;
  END IF;

  IF v_has_existing AND v_changed AND NOT v_coverage_changed THEN
    -- Recording an explicit capacity decision is audit-worthy even though it
    -- is intentionally outside the frozen coverage hash. It produces an audit
    -- event only; the coverage version and domain fact do not change.
    NULL;
  END IF;

  IF v_has_existing THEN
    IF v_changed THEN
      UPDATE public_core.campaign_venue_assignments
      SET province = v_session->>'province',
          venue_name = v_session->>'venueName',
          exam_date = v_session->>'examDate',
          reporting_time_hour = (v_session->>'reportingTimeHour')::integer,
          capacity_limit = NULLIF(v_session->>'capacityLimit', '')::integer,
          capacity_decision_code = v_session->>'capacityDecisionCode',
          is_active = (v_session->>'isActive')::boolean
      WHERE campaign_id = v_campaign_id AND district = v_session->>'district';
    END IF;
  ELSE
    INSERT INTO public_core.campaign_venue_assignments
      (id, campaign_id, district, province, venue_name, exam_date,
       reporting_time_hour, capacity_limit, capacity_decision_code,
       registered_count, is_active, created_at)
    VALUES (
      v_session_id, v_campaign_id, v_session->>'district', v_session->>'province',
      v_session->>'venueName', v_session->>'examDate',
      (v_session->>'reportingTimeHour')::integer,
      NULLIF(v_session->>'capacityLimit', '')::integer,
      v_session->>'capacityDecisionCode', 0, (v_session->>'isActive')::boolean,
      v_occurred_at
    );
  END IF;

  v_expected_actual := public_core.campaign_private_actual_coverage_json(v_campaign_id);
  IF v_expected_canonical IS NULL OR v_expected_hash !~ '^[0-9a-f]{64}$'
     OR encode(public.digest(convert_to(v_expected_canonical, 'UTF8'), 'sha256'), 'hex') <> v_expected_hash
     OR v_expected_canonical::jsonb IS DISTINCT FROM v_expected_actual THEN
    RAISE EXCEPTION 'STALE_COVERAGE' USING ERRCODE = 'P0001';
  END IF;

  v_next_version := v_current_version + CASE WHEN v_coverage_changed THEN 1 ELSE 0 END;
  IF NOT v_has_head THEN
    INSERT INTO public_core.campaign_coverage_heads
      (campaign_id, agency, coverage_version, coverage_hash, updated_at)
    VALUES (v_campaign_id, v_agency, 0, v_current_hash, v_occurred_at);
  END IF;
  IF v_coverage_changed THEN
    UPDATE public_core.campaign_coverage_heads
    SET coverage_version = v_next_version, coverage_hash = v_expected_hash, updated_at = v_occurred_at
    WHERE campaign_id = v_campaign_id AND agency = v_agency;
  END IF;
  IF v_response->>'coverageVersion' IS DISTINCT FROM v_next_version::text
     OR v_response->>'coverageHash' IS DISTINCT FROM v_expected_hash
     OR (v_response->>'status' = 'SESSION_CONFIGURED') IS DISTINCT FROM v_changed
     OR v_response->>'capacityDecisionCode' IS DISTINCT FROM v_session->>'capacityDecisionCode' THEN
    RAISE EXCEPTION 'invalid session response snapshot' USING ERRCODE = '23514';
  END IF;

  v_metadata := jsonb_build_object(
    'publicCode', v_public_code,
    'district', v_session->>'district',
    'sessionChanged', v_changed,
    'capacityDecisionCode', COALESCE(v_session->'capacityDecisionCode', 'null'::jsonb),
    'coverageVersion', v_next_version
  );
  IF v_coverage_changed THEN
    v_domain_type := 'CAMPAIGN_SESSION_CONFIGURED';
    v_fact_id := v_campaign_id::text || ':' || v_next_version::text;
    v_domain_name := 'campaign-session-coverage:' || v_fact_id;
    v_domain_fields := jsonb_build_object(
      'district', v_session->>'district',
      'coverageVersion', v_next_version,
      'coverageHash', v_expected_hash,
      'configuredAt', p_command->'occurredAt'
    );
  ELSE
    v_domain_type := NULL;
    v_fact_id := NULL;
    v_domain_name := NULL;
    v_domain_fields := '{}'::jsonb;
  END IF;
  PERFORM public_core.campaign_private_stage_events(
    p_command->'events', v_command_id, v_actor, v_agency, v_campaign_id,
    v_public_code, p_command->>'correlationId', 'CONFIGURE_SESSION',
    'CAMPAIGN_SESSION_CONFIGURED', v_metadata, 'session-command:',
    v_domain_type, v_domain_name, v_fact_id, v_domain_fields, 'scheduling-service'
  );
  RETURN jsonb_build_object('replayed', false, 'commandId', v_command_id,
    'resourceId', v_campaign_id, 'responseStatus', 200,
    'responseBody', v_response, 'occurredAt', v_occurred_at);
END;
$function$;

-- Preserve ADR-026's atomic seat reservation while closing the last direct
-- session-row DML grant. The scheduler can conditionally claim a seat or undo
-- the increment after a losing slot_reservations uniqueness race, but cannot
-- write the counter itself or alter campaign configuration.
CREATE OR REPLACE FUNCTION public_core.reserve_campaign_venue_seat(p_venue_assignment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF session_user <> 'usrp_app'
     OR current_setting('role', true) IS DISTINCT FROM 'usrp_system_service' THEN
    RAISE EXCEPTION 'venue seat reservation requires the scheduling system role'
      USING ERRCODE = '42501';
  END IF;
  IF p_venue_assignment_id IS NULL THEN
    RAISE EXCEPTION 'venue assignment id is required' USING ERRCODE = '22023';
  END IF;

  UPDATE public_core.campaign_venue_assignments AS venue
  SET registered_count = venue.registered_count + 1
  WHERE venue.id = p_venue_assignment_id
    AND venue.is_active = true
    AND (venue.capacity_limit IS NULL OR venue.registered_count < venue.capacity_limit)
  RETURNING jsonb_build_object(
    'reserved', true,
    'venueExists', true,
    'capacityLimit', venue.capacity_limit,
    'registeredCount', venue.registered_count,
    'isActive', venue.is_active
  ) INTO v_result;
  IF FOUND THEN RETURN v_result; END IF;

  SELECT jsonb_build_object(
    'reserved', false,
    'venueExists', true,
    'capacityLimit', venue.capacity_limit,
    'registeredCount', venue.registered_count,
    'isActive', venue.is_active
  ) INTO v_result
  FROM public_core.campaign_venue_assignments AS venue
  WHERE venue.id = p_venue_assignment_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'reserved', false,
      'venueExists', false,
      'capacityLimit', NULL,
      'registeredCount', NULL,
      'isActive', false
    );
  END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.release_campaign_venue_seat(p_venue_assignment_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_registered_count integer;
BEGIN
  IF session_user <> 'usrp_app'
     OR current_setting('role', true) IS DISTINCT FROM 'usrp_system_service' THEN
    RAISE EXCEPTION 'venue seat release requires the scheduling system role'
      USING ERRCODE = '42501';
  END IF;
  IF p_venue_assignment_id IS NULL THEN
    RAISE EXCEPTION 'venue assignment id is required' USING ERRCODE = '22023';
  END IF;

  UPDATE public_core.campaign_venue_assignments AS venue
  SET registered_count = venue.registered_count - 1
  WHERE venue.id = p_venue_assignment_id AND venue.registered_count > 0
  RETURNING venue.registered_count INTO v_registered_count;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation seat counter cannot be decremented'
      USING ERRCODE = '23514';
  END IF;
  RETURN v_registered_count;
END;
$function$;

-- Standalone lifecycle history is not authoritative. The deferred check sees
-- final transaction state, so a history row must correspond to the status that
-- actually committed. A legal-looking edge without that update is rejected.
CREATE OR REPLACE FUNCTION public_core.campaign_private_check_history_matches_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_status public_core.campaign_status;
  v_duplicate_count integer;
BEGIN
  SELECT c.status INTO v_status
  FROM public_core.recruitment_campaigns AS c
  WHERE c.id = NEW.campaign_id AND c.agency = NEW.agency
  FOR UPDATE;
  IF NOT FOUND OR v_status IS DISTINCT FROM NEW.to_status THEN
    RAISE EXCEPTION 'campaign history row must match the committed campaign status'
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::integer INTO v_duplicate_count
  FROM public_core.campaign_lifecycle_history AS h
  WHERE h.campaign_id = NEW.campaign_id
    AND h.agency = NEW.agency
    AND h.from_status IS NOT DISTINCT FROM NEW.from_status
    AND h.to_status = NEW.to_status;
  IF v_duplicate_count > 1 THEN
    RAISE EXCEPTION 'campaign lifecycle edge can be recorded only once'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public_core.campaign_private_guard_history_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF current_user <> 'usrp_campaign_command_owner' THEN
    RAISE EXCEPTION 'lifecycle history may be inserted only by a campaign command function'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS trg_campaign_history_command_writer ON public_core.campaign_lifecycle_history;
CREATE TRIGGER trg_campaign_history_command_writer
  BEFORE INSERT ON public_core.campaign_lifecycle_history
  FOR EACH ROW EXECUTE FUNCTION public_core.campaign_private_guard_history_insert();
DROP TRIGGER IF EXISTS trg_campaign_history_matches_state ON public_core.campaign_lifecycle_history;
CREATE CONSTRAINT TRIGGER trg_campaign_history_matches_state
  AFTER INSERT ON public_core.campaign_lifecycle_history
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public_core.campaign_private_check_history_matches_state();

-- A draft's selected policy pointer can only advance to its newest policy fact.
CREATE OR REPLACE FUNCTION public_core.campaign_private_guard_current_policy_pointer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_latest_id uuid;
BEGIN
  IF NEW.current_policy_version_id IS NOT DISTINCT FROM OLD.current_policy_version_id THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'DRAFT' OR NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'selected campaign policy is frozen outside DRAFT'
      USING ERRCODE = '23514';
  END IF;
  SELECT p.id INTO v_latest_id
  FROM public_core.campaign_policy_versions AS p
  WHERE p.campaign_id = NEW.id AND p.agency = NEW.agency
  ORDER BY p.version_number DESC
  LIMIT 1;
  IF NEW.current_policy_version_id IS DISTINCT FROM v_latest_id THEN
    RAISE EXCEPTION 'campaign policy pointer must select the newest immutable policy version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS trg_campaign_policy_pointer_guard ON public_core.recruitment_campaigns;
CREATE TRIGGER trg_campaign_policy_pointer_guard
  BEFORE UPDATE OF current_policy_version_id ON public_core.recruitment_campaigns
  FOR EACH ROW EXECUTE FUNCTION public_core.campaign_private_guard_current_policy_pointer();

-- Database-side capacity decision constraint is deliberately command-aware:
-- legacy NULL rows remain operable under ADR-026, while every BUILD-001 publish
-- function requires an explicit UNBOUNDED_CAPACITY code and matching audit.

ALTER FUNCTION public_core.campaign_private_uuid_v5(uuid, text) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_private_authorize_admin(uuid, public_core.agency) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_private_claim_command(uuid, uuid, public_core.agency, text, uuid, text, uuid, integer, jsonb) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_private_claim_session_command(uuid, uuid, public_core.agency, text, uuid, text, uuid, jsonb) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_read_command_replay(uuid, public_core.agency, text, uuid, text) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_read_session_command_replay(uuid, public_core.agency, text, uuid, text) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_private_utf16_sort_key(text) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_private_actual_coverage_json(uuid) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_private_stage_events(jsonb, uuid, uuid, public_core.agency, uuid, text, text, text, text, jsonb, text, text, text, text, jsonb, text) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_private_district_province(text) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_lock_for_command(uuid, public_core.agency, text) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_lock_coverage_head(uuid, public_core.agency, uuid) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_private_write_history(uuid, public_core.agency, public_core.campaign_status, public_core.campaign_status, uuid, text, timestamptz, uuid) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_write_draft(jsonb) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_write_policy_version(jsonb) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_write_publication(jsonb) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_private_write_lifecycle(jsonb, text, text, public_core.campaign_status) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_close_registration(jsonb) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_complete(jsonb) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_cancel(jsonb) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.scheduling_configure_campaign_session(jsonb) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_private_check_history_matches_state() OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_private_guard_history_insert() OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.campaign_private_guard_current_policy_pointer() OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.reserve_campaign_venue_seat(uuid) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.release_campaign_venue_seat(uuid) OWNER TO usrp_campaign_command_owner;
ALTER FUNCTION public_core.provision_first_campaign_agency_admin(uuid, text, text, public_core.agency, text, text)
  OWNER TO usrp_campaign_admin_provision_owner;

-- The separate first-admin provisioner has only credential-store and outbox
-- privileges. It can call the deterministic UUID helper, but cannot write any
-- campaign aggregate or scheduling table.
GRANT EXECUTE ON FUNCTION public_core.campaign_private_uuid_v5(uuid, text)
  TO usrp_campaign_admin_provision_owner;

REVOKE ALL ON FUNCTION public_core.campaign_private_uuid_v5(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_private_authorize_admin(uuid, public_core.agency) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.provision_first_campaign_agency_admin(uuid, text, text, public_core.agency, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_private_claim_command(uuid, uuid, public_core.agency, text, uuid, text, uuid, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_private_claim_session_command(uuid, uuid, public_core.agency, text, uuid, text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_read_command_replay(uuid, public_core.agency, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_read_session_command_replay(uuid, public_core.agency, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_private_utf16_sort_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_private_actual_coverage_json(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_private_stage_events(jsonb, uuid, uuid, public_core.agency, uuid, text, text, text, text, jsonb, text, text, text, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_private_district_province(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_private_write_history(uuid, public_core.agency, public_core.campaign_status, public_core.campaign_status, uuid, text, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_private_write_lifecycle(jsonb, text, text, public_core.campaign_status) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_private_check_history_matches_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_private_guard_history_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_private_guard_current_policy_pointer() FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.reserve_campaign_venue_seat(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.release_campaign_venue_seat(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_lock_for_command(uuid, public_core.agency, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_lock_coverage_head(uuid, public_core.agency, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_write_draft(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_write_policy_version(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_write_publication(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_close_registration(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_complete(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.campaign_cancel(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.scheduling_configure_campaign_session(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public_core.campaign_lock_for_command(uuid, public_core.agency, text),
  public_core.campaign_lock_coverage_head(uuid, public_core.agency, uuid),
  public_core.campaign_read_command_replay(uuid, public_core.agency, text, uuid, text),
  public_core.campaign_read_session_command_replay(uuid, public_core.agency, text, uuid, text),
  public_core.campaign_write_draft(jsonb),
  public_core.campaign_write_policy_version(jsonb),
  public_core.campaign_write_publication(jsonb),
  public_core.campaign_close_registration(jsonb),
  public_core.campaign_complete(jsonb),
  public_core.campaign_cancel(jsonb),
  public_core.scheduling_configure_campaign_session(jsonb)
  TO usrp_app, usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;
GRANT EXECUTE ON FUNCTION public_core.provision_first_campaign_agency_admin(uuid, text, text, public_core.agency, text, text)
  TO usrp_iam_service;
GRANT EXECUTE ON FUNCTION public_core.reserve_campaign_venue_seat(uuid),
  public_core.release_campaign_venue_seat(uuid) TO usrp_system_service;

-- The command roles need CREATE only while ownership is assigned above. They
-- are NOLOGIN implementation roles and do not retain schema-object creation.
REVOKE CREATE ON SCHEMA public_core
  FROM usrp_campaign_command_owner, usrp_campaign_admin_provision_owner;

COMMIT;
