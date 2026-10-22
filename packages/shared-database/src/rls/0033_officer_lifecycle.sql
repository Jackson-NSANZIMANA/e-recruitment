-- ══════════════════════════════════════════════════════════════════
-- 0033 — Officer lifecycle command boundary (ADR-036)
--
-- Agency administrators list, create (with a one-time activation code),
-- assign posts to, disable/enable and revoke the browser sessions of officers
-- in their OWN agency. usrp_iam_service stays SELECT-only on the credential
-- store (rls/0010): every write runs through an operation-specific SECURITY
-- DEFINER function owned by the NOLOGIN usrp_officer_command_owner, the same
-- pattern as the BUILD-001 campaign functions (rls/0027).
--
-- Every admin function re-checks, from the database, that:
--   • the session login is usrp_app and the active role is usrp_iam_service;
--   • the transaction-local usrp.officer_actor_id equals the actor argument;
--   • the actor is an ACTIVE agency_admin of the requested agency.
-- A disabled administrator still holding a one-hour bearer token can
-- therefore do nothing. The transaction-local actor guards against
-- substitution; it is not an independent identity proof (usrp_app can set
-- custom settings), so the authenticated iam-service remains the trust
-- boundary for WHO, exactly as in rls/0027.
--
-- Guards (inside the functions, mirrored by the iam-service pure domain):
-- same agency only (a cross-agency target is NOT_FOUND); no self-modification;
-- the last active agency_admin cannot be disabled; agency_admin is never an
-- assignable post; unknown posts refused; closed reason codes only.
--
-- Access ends on the next request: disabling an officer or changing their
-- posts revokes their edge sessions in the SAME transaction (edge_sessions
-- caches roles), blanking the sealed upstream credential as logout does.
--
-- Initial credential (owner decision): a one-time activation code, 100 bits,
-- shown once, stored as SHA-256 only, 24h expiry, single use. The officer sets
-- a scrypt password via officer_activate. No plaintext password is generated.
--
-- FOUR-EYES (ADR-036 addendum, owner decision, S06): the administrator who
-- creates or reissues an officer NEVER sees the code. create/reissue open a
-- pending activation WITHOUT a code; a DIFFERENT active agency_admin of the
-- same agency performs officer_release_activation, which generates the code
-- at that moment, returns it exactly once and stores only its hash. The
-- creator (first issuer) and the latest issuer are refused (SAME_ADMIN); a
-- second release is refused (ALREADY_RELEASED: reissue instead). The code
-- does not exist anywhere before release, so nothing can be derived from the
-- create/reissue answer. Every release is audited.
--
-- Every command stages exactly one PII-free AUDIT_ENTRY (producer
-- iam-service) in the outbox, in the same transaction. Never a credential,
-- activation code or code hash.
--
-- Run as usrp_admin AFTER db:migrate, 0001, 0010, 0019, 0020, 0025, 0027.
-- Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

-- ── Account columns + the pending status ──────────────────────────
ALTER TABLE public_core.officer_accounts
  ADD COLUMN IF NOT EXISTS activated_at  timestamptz,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- 'pending' = created by an administrator, activation code not yet redeemed.
-- Login refuses anything that is not exactly 'active' (fail closed).
ALTER TABLE public_core.officer_accounts
  DROP CONSTRAINT IF EXISTS officer_accounts_status_check;
ALTER TABLE public_core.officer_accounts
  ADD CONSTRAINT officer_accounts_status_check
  CHECK (status IN ('active', 'disabled', 'pending'));

-- Accounts that already hold a real scrypt credential were activated by
-- whoever provisioned them. Replay-safe: only NULLs whose credential is a
-- real digest (a pending account's sentinel never matches).
UPDATE public_core.officer_accounts
SET activated_at = created_at
WHERE activated_at IS NULL AND credential LIKE 'scrypt$%';

-- Accounts inserted directly by the operator paths (first-admin provisioner,
-- dev seeder) arrive with a real digest and are therefore already activated.
CREATE OR REPLACE FUNCTION public_core.officer_private_stamp_activation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.activated_at IS NULL AND NEW.status <> 'pending' AND NEW.credential LIKE 'scrypt$%' THEN
    NEW.activated_at := NEW.created_at;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public_core.officer_private_stamp_activation() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_officer_accounts_stamp_activation ON public_core.officer_accounts;
CREATE TRIGGER trg_officer_accounts_stamp_activation
  BEFORE INSERT ON public_core.officer_accounts
  FOR EACH ROW EXECUTE FUNCTION public_core.officer_private_stamp_activation();

-- ── One-time activation codes ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public_core.officer_activation_codes (
  officer_id   uuid        PRIMARY KEY
                           REFERENCES public_core.officer_accounts (officer_id) ON DELETE CASCADE,
  code_hash    varchar(64),            -- SHA-256 hex of the normalised code; never the code; NULL until released
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,   -- until release: the release deadline; after: the code's expiry
  issued_by    uuid        NOT NULL,   -- the latest creating/reissuing administrator
  redeemed_at  timestamptz,
  created_by   uuid,                   -- the administrator who created the account; never overwritten
  released_at  timestamptz,
  released_by  uuid
);

-- Four-eyes columns for databases that already hold the S01 shape (replay-safe).
ALTER TABLE public_core.officer_activation_codes
  ADD COLUMN IF NOT EXISTS created_by  uuid,
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_by uuid;
ALTER TABLE public_core.officer_activation_codes ALTER COLUMN code_hash DROP NOT NULL;
UPDATE public_core.officer_activation_codes SET created_by = issued_by WHERE created_by IS NULL;
-- A code issued under the S01 contract was visible to its creator: it is void.
-- Those accounts need a release by a second administrator.
UPDATE public_core.officer_activation_codes
SET code_hash = NULL, expires_at = now() + interval '24 hours'
WHERE released_at IS NULL AND code_hash IS NOT NULL AND redeemed_at IS NULL;
ALTER TABLE public_core.officer_activation_codes
  DROP CONSTRAINT IF EXISTS officer_activation_codes_release_check;
ALTER TABLE public_core.officer_activation_codes
  ADD CONSTRAINT officer_activation_codes_release_check
  CHECK ((code_hash IS NULL) = (released_at IS NULL) OR redeemed_at IS NOT NULL);

-- No login role receives any privilege on the code store. Only the command
-- owner (BYPASSRLS) reaches it, through the functions below.
REVOKE ALL PRIVILEGES ON TABLE public_core.officer_activation_codes
  FROM PUBLIC, usrp_app, usrp_iam_service, usrp_system_service, usrp_edge_gateway,
       usrp_rdf_officer, usrp_rnp_officer, usrp_rcs_officer;
ALTER TABLE public_core.officer_activation_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.officer_activation_codes FORCE  ROW LEVEL SECURITY;

-- ── The private command owner ─────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usrp_officer_command_owner') THEN
    CREATE ROLE usrp_officer_command_owner NOLOGIN BYPASSRLS;
  END IF;
END$$;
ALTER ROLE usrp_officer_command_owner
  WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN BYPASSRLS;
-- Never a member of anything, never assumable by anything.
DO $$
DECLARE
  v_membership record;
BEGIN
  FOR v_membership IN
    SELECT granted.rolname AS granted_role, member.rolname AS member_role
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE granted.rolname = 'usrp_officer_command_owner'
       OR member.rolname = 'usrp_officer_command_owner'
  LOOP
    EXECUTE format('REVOKE %I FROM %I', v_membership.granted_role, v_membership.member_role);
  END LOOP;
END$$;

GRANT USAGE ON SCHEMA public_core TO usrp_officer_command_owner;
GRANT CREATE ON SCHEMA public_core TO usrp_officer_command_owner;
GRANT SELECT, INSERT ON public_core.officer_accounts TO usrp_officer_command_owner;
GRANT UPDATE (roles, status, credential, activated_at, last_login_at)
  ON public_core.officer_accounts TO usrp_officer_command_owner;
GRANT SELECT, INSERT, UPDATE ON public_core.officer_activation_codes TO usrp_officer_command_owner;
GRANT SELECT (session_id, kind, subject_id, revoked_at)
  ON public_core.edge_sessions TO usrp_officer_command_owner;
GRANT UPDATE (revoked_at, revoked_reason, upstream_credential, previous_handle_hash,
              previous_csrf_token_hash, previous_valid_until)
  ON public_core.edge_sessions TO usrp_officer_command_owner;
GRANT INSERT ON public_core.event_outbox TO usrp_officer_command_owner;
GRANT USAGE ON SEQUENCE public_core.event_outbox_id_seq TO usrp_officer_command_owner;

-- ── Private helpers (SECURITY INVOKER; reachable only from the owner) ──

CREATE OR REPLACE FUNCTION public_core.officer_private_assert_iam_caller()
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF session_user <> 'usrp_app' THEN
    RAISE EXCEPTION 'officer commands are available only to the application database login'
      USING ERRCODE = '42501';
  END IF;
  -- The function owner bypasses RLS, so pin the invoking database role.
  IF current_setting('role', true) IS DISTINCT FROM 'usrp_iam_service' THEN
    RAISE EXCEPTION 'officer commands require the iam-service database role'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.officer_private_authorize_admin(
  p_actor_id uuid,
  p_agency public_core.agency
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_agency public_core.agency;
  v_roles text[];
  v_status text;
BEGIN
  PERFORM public_core.officer_private_assert_iam_caller();
  IF p_actor_id IS NULL OR p_agency IS NULL THEN
    RAISE EXCEPTION 'officer command requires an actor and an agency' USING ERRCODE = '42501';
  END IF;
  -- Set by the adapter from the already-verified officer principal.
  IF current_setting('usrp.officer_actor_id', true) IS DISTINCT FROM p_actor_id::text THEN
    RAISE EXCEPTION 'officer command actor does not match transaction actor context'
      USING ERRCODE = '42501';
  END IF;

  SELECT oa.agency, oa.roles, oa.status
    INTO v_agency, v_roles, v_status
  FROM public_core.officer_accounts AS oa
  WHERE oa.officer_id = p_actor_id;

  IF NOT FOUND OR v_status <> 'active' OR v_agency IS DISTINCT FROM p_agency
     OR NOT ('agency_admin' = ANY(COALESCE(v_roles, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'officer command requires an active agency_admin principal'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

-- Caller-controlled correlation ids are replaced by the adapter when they do
-- not match; the function still refuses a malformed one.
CREATE OR REPLACE FUNCTION public_core.officer_private_assert_correlation(p_correlation_id text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9._:-]{3,128}$' THEN
    RAISE EXCEPTION 'invalid correlation id' USING ERRCODE = '22023';
  END IF;
END;
$function$;

-- NULL when the post set is acceptable, otherwise the closed refusal reason.
CREATE OR REPLACE FUNCTION public_core.officer_private_posts_refusal(p_posts text[])
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_assignable constant text[] := ARRAY[
    'reviewer', 'screening_officer', 'field_supervisor', 'medical_officer',
    'adjudicator', 'decision_authority', 'dpo'
  ];
BEGIN
  IF p_posts IS NULL OR cardinality(p_posts) = 0 OR cardinality(p_posts) > cardinality(v_assignable)
     OR array_position(p_posts, NULL) IS NOT NULL THEN
    RETURN 'INVALID_POSTS';
  END IF;
  IF 'agency_admin' = ANY(p_posts) THEN
    RETURN 'AGENCY_ADMIN_NOT_ASSIGNABLE';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_posts) AS post WHERE NOT (post = ANY(v_assignable))) THEN
    RETURN 'UNKNOWN_POST';
  END IF;
  IF (SELECT count(DISTINCT post) FROM unnest(p_posts) AS post) <> cardinality(p_posts) THEN
    RETURN 'INVALID_POSTS';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.officer_private_sorted(p_values text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(array_agg(v ORDER BY v), ARRAY[]::text[]) FROM unnest(p_values) AS v;
$function$;

CREATE OR REPLACE FUNCTION public_core.officer_private_normalise_code(p_code text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT upper(regexp_replace(COALESCE(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
$function$;

CREATE OR REPLACE FUNCTION public_core.officer_private_code_hash(p_code text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT encode(public.digest(convert_to(public_core.officer_private_normalise_code(p_code), 'UTF8'), 'sha256'), 'hex');
$function$;

-- Open (or reopen) a pending activation for an officer. NO code exists yet:
-- the issuing administrator never holds one. The code is generated by
-- officer_release_activation, for a different administrator.
DROP FUNCTION IF EXISTS public_core.officer_private_issue_code(uuid, uuid, timestamptz);
CREATE OR REPLACE FUNCTION public_core.officer_private_open_activation(
  p_officer_id uuid,
  p_issued_by uuid,
  p_now timestamptz
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO public_core.officer_activation_codes
    (officer_id, code_hash, issued_at, expires_at, issued_by, redeemed_at, created_by, released_at, released_by)
  VALUES (p_officer_id, NULL, p_now, p_now + interval '24 hours', p_issued_by, NULL, p_issued_by, NULL, NULL)
  ON CONFLICT (officer_id) DO UPDATE
    SET code_hash = NULL,
        issued_at = EXCLUDED.issued_at,
        expires_at = EXCLUDED.expires_at,
        issued_by = EXCLUDED.issued_by,
        redeemed_at = NULL,
        released_at = NULL,
        released_by = NULL;
END;
$function$;

-- End every live browser session of an officer now. Returns how many.
CREATE OR REPLACE FUNCTION public_core.officer_private_revoke_sessions(
  p_officer_id uuid,
  p_reason text,
  p_now timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_count integer;
BEGIN
  UPDATE public_core.edge_sessions
  SET revoked_at = p_now,
      revoked_reason = left(p_reason, 32),
      upstream_credential = '',
      previous_handle_hash = NULL,
      previous_csrf_token_hash = NULL,
      previous_valid_until = NULL
  WHERE kind = 'officer' AND subject_id = p_officer_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- Stage the one PII-free audit envelope of a command.
CREATE OR REPLACE FUNCTION public_core.officer_private_stage_audit(
  p_action text,
  p_target_id uuid,
  p_performed_by uuid,
  p_agency public_core.agency,
  p_correlation_id text,
  p_metadata jsonb,
  p_now timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_event_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public_core.event_outbox (event_id, event_type, producer, payload)
  VALUES (
    v_event_id,
    'AUDIT_ENTRY',
    'iam-service',
    jsonb_build_object(
      'eventId', v_event_id::text,
      'eventVersion', '1.0',
      'schemaVersion', '1.0',
      'piiClassification', 'NONE',
      'occurredAt', to_char(p_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'correlationId', p_correlation_id,
      'causationId', p_correlation_id,
      'eventType', 'AUDIT_ENTRY',
      'entityType', 'OFFICER',
      'entityId', p_target_id::text,
      'action', p_action,
      'performedBy', p_performed_by::text,
      'agency', p_agency::text,
      'metadata', COALESCE(p_metadata, '{}'::jsonb)
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.officer_private_view(p_officer_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'officerId', oa.officer_id,
    'loginHandle', oa.login_handle,
    'posts', to_jsonb(public_core.officer_private_sorted(oa.roles)),
    'status', oa.status,
    'createdAt', oa.created_at,
    'activatedAt', oa.activated_at,
    'lastLoginAt', oa.last_login_at,
    'activationExpiresAt', CASE
      WHEN oa.status = 'pending' AND ac.redeemed_at IS NULL THEN to_jsonb(ac.expires_at)
      ELSE 'null'::jsonb END,
    'activationState', CASE
      WHEN oa.status = 'pending' AND ac.officer_id IS NOT NULL AND ac.redeemed_at IS NULL
        THEN to_jsonb(CASE
          WHEN ac.expires_at <= clock_timestamp() THEN 'EXPIRED'
          WHEN ac.released_at IS NULL THEN 'PENDING_RELEASE'
          ELSE 'RELEASED' END)
      ELSE 'null'::jsonb END,
    -- Relative to the viewing administrator (the transaction-bound actor), so
    -- every officer row in every answer says the same thing.
    'releasableByYou', (
      oa.status = 'pending' AND ac.officer_id IS NOT NULL AND ac.redeemed_at IS NULL
      AND ac.released_at IS NULL AND ac.expires_at > clock_timestamp()
      AND nullif(current_setting('usrp.officer_actor_id', true), '') IS NOT NULL
      AND ac.issued_by <> nullif(current_setting('usrp.officer_actor_id', true), '')::uuid
      AND COALESCE(ac.created_by, ac.issued_by) <> nullif(current_setting('usrp.officer_actor_id', true), '')::uuid
    )
  )
  FROM public_core.officer_accounts AS oa
  LEFT JOIN public_core.officer_activation_codes AS ac ON ac.officer_id = oa.officer_id
  WHERE oa.officer_id = p_officer_id;
$function$;

-- Lock and load a target in the actor's agency. NULL = absent OR another
-- agency's (one answer, no cross-agency oracle).
CREATE OR REPLACE FUNCTION public_core.officer_private_lock_target(
  p_officer_id uuid,
  p_agency public_core.agency
)
RETURNS public_core.officer_accounts
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_row public_core.officer_accounts;
BEGIN
  IF p_officer_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_row
  FROM public_core.officer_accounts AS oa
  WHERE oa.officer_id = p_officer_id AND oa.agency = p_agency
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.officer_private_refused(p_reason text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT jsonb_build_object('outcome', 'REFUSED', 'reason', p_reason);
$function$;

-- ── Public command functions (SECURITY DEFINER) ───────────────────

CREATE OR REPLACE FUNCTION public_core.officer_list(
  p_actor_id uuid,
  p_agency public_core.agency
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM public_core.officer_private_authorize_admin(p_actor_id, p_agency);
  RETURN COALESCE(
    (SELECT jsonb_agg(
              public_core.officer_private_view(oa.officer_id)
              ORDER BY oa.login_handle)
     FROM public_core.officer_accounts AS oa
     WHERE oa.agency = p_agency),
    '[]'::jsonb
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.officer_create(
  p_actor_id uuid,
  p_agency public_core.agency,
  p_login_handle text,
  p_posts text[],
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_now timestamptz := transaction_timestamp();
  v_handle text := lower(btrim(COALESCE(p_login_handle, '')));
  v_refusal text;
  v_officer_id uuid := gen_random_uuid();
  v_posts text[];
BEGIN
  PERFORM public_core.officer_private_authorize_admin(p_actor_id, p_agency);
  PERFORM public_core.officer_private_assert_correlation(p_correlation_id);

  IF v_handle !~ '^[a-z0-9][a-z0-9._-]{2,63}$' THEN
    RETURN public_core.officer_private_refused('INVALID_HANDLE');
  END IF;
  v_refusal := public_core.officer_private_posts_refusal(p_posts);
  IF v_refusal IS NOT NULL THEN
    RETURN public_core.officer_private_refused(v_refusal);
  END IF;
  v_posts := public_core.officer_private_sorted(p_posts);

  -- Handles are unique platform-wide; serialise competing creates of one handle.
  PERFORM pg_advisory_xact_lock(hashtextextended('officer-handle:' || v_handle, 0));
  IF EXISTS (SELECT 1 FROM public_core.officer_accounts WHERE login_handle = v_handle) THEN
    RETURN public_core.officer_private_refused('HANDLE_TAKEN');
  END IF;

  -- A non-verifiable sentinel: never a scrypt digest, never a password.
  INSERT INTO public_core.officer_accounts
    (officer_id, login_handle, credential, agency, roles, status, created_at)
  VALUES (v_officer_id, v_handle, 'pending$' || encode(public.gen_random_bytes(16), 'hex'),
          p_agency, v_posts, 'pending', v_now);

  PERFORM public_core.officer_private_open_activation(v_officer_id, p_actor_id, v_now);

  PERFORM public_core.officer_private_stage_audit(
    'OFFICER_CREATED', v_officer_id, p_actor_id, p_agency, p_correlation_id,
    jsonb_build_object(
      'posts', to_jsonb(v_posts),
      'grantsDecisionAuthority', 'decision_authority' = ANY(v_posts),
      'credentialDelivery', 'ONE_TIME_ACTIVATION_CODE_RELEASED_BY_SECOND_ADMIN'
    ),
    v_now
  );

  RETURN jsonb_build_object(
    'outcome', 'CREATED',
    'officer', public_core.officer_private_view(v_officer_id)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.officer_reissue_activation(
  p_actor_id uuid,
  p_agency public_core.agency,
  p_officer_id uuid,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_now timestamptz := transaction_timestamp();
  v_target public_core.officer_accounts;
BEGIN
  PERFORM public_core.officer_private_authorize_admin(p_actor_id, p_agency);
  PERFORM public_core.officer_private_assert_correlation(p_correlation_id);

  v_target := public_core.officer_private_lock_target(p_officer_id, p_agency);
  IF v_target.officer_id IS NULL THEN
    RETURN public_core.officer_private_refused('NOT_FOUND');
  END IF;
  IF v_target.officer_id = p_actor_id THEN
    RETURN public_core.officer_private_refused('SELF_MODIFICATION');
  END IF;
  -- Never a password reset: only an account that has never been activated.
  IF v_target.status <> 'pending' OR v_target.activated_at IS NOT NULL
     OR v_target.credential LIKE 'scrypt$%' THEN
    RETURN public_core.officer_private_refused('NOT_PENDING_ACTIVATION');
  END IF;

  PERFORM public_core.officer_private_open_activation(v_target.officer_id, p_actor_id, v_now);
  PERFORM public_core.officer_private_stage_audit(
    'OFFICER_ACTIVATION_REISSUED', v_target.officer_id, p_actor_id, p_agency, p_correlation_id,
    jsonb_build_object('credentialDelivery', 'ONE_TIME_ACTIVATION_CODE_RELEASED_BY_SECOND_ADMIN'),
    v_now
  );
  RETURN jsonb_build_object(
    'outcome', 'REISSUED',
    'officer', public_core.officer_private_view(v_target.officer_id)
  );
END;
$function$;

-- FOUR-EYES RELEASE. A DIFFERENT active agency_admin of the same agency
-- generates and receives the one-time code, exactly once. Refusals:
--   NOT_FOUND               absent or another agency's (one answer)
--   NOT_PENDING_ACTIVATION  already activated, disabled, or no open activation
--   SAME_ADMIN              the actor created or last (re)issued this activation
--   ALREADY_RELEASED        the code was already released: reissue instead
--   ACTIVATION_EXPIRED      the release window passed: reissue instead
CREATE OR REPLACE FUNCTION public_core.officer_release_activation(
  p_actor_id uuid,
  p_agency public_core.agency,
  p_officer_id uuid,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_now timestamptz := transaction_timestamp();
  v_target public_core.officer_accounts;
  v_row public_core.officer_activation_codes;
  v_bytes bytea;
  v_raw text := '';
  v_expires timestamptz;
BEGIN
  v_expires := v_now + interval '24 hours';
  PERFORM public_core.officer_private_authorize_admin(p_actor_id, p_agency);
  PERFORM public_core.officer_private_assert_correlation(p_correlation_id);

  v_target := public_core.officer_private_lock_target(p_officer_id, p_agency);
  IF v_target.officer_id IS NULL THEN
    RETURN public_core.officer_private_refused('NOT_FOUND');
  END IF;
  IF v_target.status <> 'pending' OR v_target.activated_at IS NOT NULL
     OR v_target.credential LIKE 'scrypt$%' THEN
    RETURN public_core.officer_private_refused('NOT_PENDING_ACTIVATION');
  END IF;

  SELECT * INTO v_row FROM public_core.officer_activation_codes WHERE officer_id = v_target.officer_id FOR UPDATE;
  IF NOT FOUND OR v_row.redeemed_at IS NOT NULL THEN
    RETURN public_core.officer_private_refused('NOT_PENDING_ACTIVATION');
  END IF;
  IF p_actor_id = v_row.issued_by OR p_actor_id = COALESCE(v_row.created_by, v_row.issued_by) THEN
    RETURN public_core.officer_private_refused('SAME_ADMIN');
  END IF;
  IF v_row.released_at IS NOT NULL THEN
    RETURN public_core.officer_private_refused('ALREADY_RELEASED');
  END IF;
  IF v_row.expires_at <= v_now THEN
    RETURN public_core.officer_private_refused('ACTIVATION_EXPIRED');
  END IF;

  -- 20 symbols from a 32-symbol alphabet = 100 bits. Generated NOW, for this
  -- administrator only; stored as a hash.
  v_bytes := public.gen_random_bytes(20);
  FOR i IN 0..19 LOOP
    v_raw := v_raw || substr(v_alphabet, (get_byte(v_bytes, i) & 31) + 1, 1);
  END LOOP;
  UPDATE public_core.officer_activation_codes
  SET code_hash = public_core.officer_private_code_hash(v_raw),
      released_at = v_now,
      released_by = p_actor_id,
      expires_at = v_expires
  WHERE officer_id = v_target.officer_id;

  PERFORM public_core.officer_private_stage_audit(
    'OFFICER_ACTIVATION_RELEASED', v_target.officer_id, p_actor_id, p_agency, p_correlation_id,
    jsonb_build_object(
      'issuedBy', v_row.issued_by,
      'grantsDecisionAuthority', 'decision_authority' = ANY(v_target.roles),
      'credentialDelivery', 'ONE_TIME_ACTIVATION_CODE_RELEASED_BY_SECOND_ADMIN'
    ),
    v_now
  );
  RETURN jsonb_build_object(
    'outcome', 'RELEASED',
    'officer', public_core.officer_private_view(v_target.officer_id),
    'activation', jsonb_build_object(
      'code', substr(v_raw, 1, 5) || '-' || substr(v_raw, 6, 5) || '-' ||
              substr(v_raw, 11, 5) || '-' || substr(v_raw, 16, 5),
      'expiresAt', v_expires
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.officer_assign_posts(
  p_actor_id uuid,
  p_agency public_core.agency,
  p_officer_id uuid,
  p_posts text[],
  p_reason_code text,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_now timestamptz := transaction_timestamp();
  v_target public_core.officer_accounts;
  v_refusal text;
  v_previous text[];
  v_next text[];
  v_revoked integer;
BEGIN
  PERFORM public_core.officer_private_authorize_admin(p_actor_id, p_agency);
  PERFORM public_core.officer_private_assert_correlation(p_correlation_id);

  IF p_reason_code IS NULL OR NOT (p_reason_code = ANY(ARRAY['POSTING_CHANGE', 'CORRECTION', 'TEMPORARY_COVER', 'OTHER'])) THEN
    RETURN public_core.officer_private_refused('INVALID_REASON');
  END IF;
  v_target := public_core.officer_private_lock_target(p_officer_id, p_agency);
  IF v_target.officer_id IS NULL THEN
    RETURN public_core.officer_private_refused('NOT_FOUND');
  END IF;
  IF v_target.officer_id = p_actor_id THEN
    RETURN public_core.officer_private_refused('SELF_MODIFICATION');
  END IF;
  v_refusal := public_core.officer_private_posts_refusal(p_posts);
  IF v_refusal IS NOT NULL THEN
    RETURN public_core.officer_private_refused(v_refusal);
  END IF;

  v_previous := public_core.officer_private_sorted(v_target.roles);
  -- agency_admin is preserved, never added (owner decision: only the
  -- first-admin provisioner path creates an administrator).
  v_next := public_core.officer_private_sorted(
    p_posts || CASE WHEN 'agency_admin' = ANY(v_previous) THEN ARRAY['agency_admin'] ELSE ARRAY[]::text[] END
  );
  IF v_next = v_previous THEN
    RETURN jsonb_build_object('outcome', 'UNCHANGED', 'officer', public_core.officer_private_view(v_target.officer_id), 'sessionsRevoked', 0);
  END IF;

  UPDATE public_core.officer_accounts SET roles = v_next WHERE officer_id = v_target.officer_id;
  -- The edge session caches roles: end it so the next request re-authenticates.
  v_revoked := public_core.officer_private_revoke_sessions(v_target.officer_id, 'POSTS_CHANGED', v_now);

  PERFORM public_core.officer_private_stage_audit(
    'OFFICER_POSTS_ASSIGNED', v_target.officer_id, p_actor_id, p_agency, p_correlation_id,
    jsonb_build_object(
      'previousPosts', to_jsonb(v_previous),
      'posts', to_jsonb(v_next),
      'grantsDecisionAuthority', ('decision_authority' = ANY(v_next)) AND NOT ('decision_authority' = ANY(v_previous)),
      'reasonCode', p_reason_code,
      'sessionsRevoked', v_revoked
    ),
    v_now
  );
  RETURN jsonb_build_object('outcome', 'ASSIGNED', 'officer', public_core.officer_private_view(v_target.officer_id), 'sessionsRevoked', v_revoked);
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.officer_set_status(
  p_actor_id uuid,
  p_agency public_core.agency,
  p_officer_id uuid,
  p_target_status text,
  p_reason_code text,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_now timestamptz := transaction_timestamp();
  v_target public_core.officer_accounts;
  v_new_status text;
  v_revoked integer := 0;
  v_other_admins integer;
BEGIN
  PERFORM public_core.officer_private_authorize_admin(p_actor_id, p_agency);
  PERFORM public_core.officer_private_assert_correlation(p_correlation_id);

  IF p_target_status IS NULL OR p_target_status NOT IN ('active', 'disabled') THEN
    RAISE EXCEPTION 'invalid target status' USING ERRCODE = '22023';
  END IF;
  IF p_reason_code IS NULL
     OR (p_target_status = 'disabled' AND NOT (p_reason_code = ANY(ARRAY['LEFT_SERVICE', 'SUSPENDED', 'SECURITY_CONCERN', 'EXTENDED_LEAVE', 'OTHER'])))
     OR (p_target_status = 'active' AND NOT (p_reason_code = ANY(ARRAY['RETURNED_TO_DUTY', 'SUSPENSION_LIFTED', 'CORRECTION', 'OTHER']))) THEN
    RETURN public_core.officer_private_refused('INVALID_REASON');
  END IF;

  -- Serialise every status change in this agency, so two administrators
  -- disabling each other cannot both succeed.
  PERFORM pg_advisory_xact_lock(hashtextextended('officer-admin-status:' || p_agency::text, 0));
  v_target := public_core.officer_private_lock_target(p_officer_id, p_agency);
  IF v_target.officer_id IS NULL THEN
    RETURN public_core.officer_private_refused('NOT_FOUND');
  END IF;

  IF p_target_status = 'disabled' THEN
    IF v_target.status = 'active' AND 'agency_admin' = ANY(v_target.roles) THEN
      SELECT count(*)::integer INTO v_other_admins
      FROM public_core.officer_accounts AS oa
      WHERE oa.agency = p_agency AND oa.status = 'active'
        AND 'agency_admin' = ANY(oa.roles) AND oa.officer_id <> v_target.officer_id;
      IF v_other_admins = 0 THEN
        RETURN public_core.officer_private_refused('LAST_ACTIVE_ADMIN');
      END IF;
    END IF;
    IF v_target.officer_id = p_actor_id THEN
      RETURN public_core.officer_private_refused('SELF_MODIFICATION');
    END IF;
    IF v_target.status = 'disabled' THEN
      RETURN jsonb_build_object('outcome', 'UNCHANGED', 'officer', public_core.officer_private_view(v_target.officer_id), 'sessionsRevoked', 0);
    END IF;
    UPDATE public_core.officer_accounts SET status = 'disabled' WHERE officer_id = v_target.officer_id;
    v_revoked := public_core.officer_private_revoke_sessions(v_target.officer_id, 'ACCOUNT_DISABLED', v_now);
    PERFORM public_core.officer_private_stage_audit(
      'OFFICER_DISABLED', v_target.officer_id, p_actor_id, p_agency, p_correlation_id,
      jsonb_build_object('previousStatus', v_target.status, 'reasonCode', p_reason_code, 'sessionsRevoked', v_revoked),
      v_now
    );
    RETURN jsonb_build_object('outcome', 'DISABLED', 'officer', public_core.officer_private_view(v_target.officer_id), 'sessionsRevoked', v_revoked);
  END IF;

  -- Enable.
  IF v_target.officer_id = p_actor_id THEN
    RETURN public_core.officer_private_refused('SELF_MODIFICATION');
  END IF;
  IF v_target.status <> 'disabled' THEN
    RETURN jsonb_build_object('outcome', 'UNCHANGED', 'officer', public_core.officer_private_view(v_target.officer_id), 'sessionsRevoked', 0);
  END IF;
  -- An account disabled before activation returns to pending, never to active.
  v_new_status := CASE
    WHEN v_target.activated_at IS NULL AND v_target.credential NOT LIKE 'scrypt$%' THEN 'pending'
    ELSE 'active' END;
  UPDATE public_core.officer_accounts SET status = v_new_status WHERE officer_id = v_target.officer_id;
  PERFORM public_core.officer_private_stage_audit(
    'OFFICER_ENABLED', v_target.officer_id, p_actor_id, p_agency, p_correlation_id,
    jsonb_build_object('status', v_new_status, 'reasonCode', p_reason_code),
    v_now
  );
  RETURN jsonb_build_object('outcome', 'ENABLED', 'officer', public_core.officer_private_view(v_target.officer_id), 'sessionsRevoked', 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public_core.officer_revoke_sessions(
  p_actor_id uuid,
  p_agency public_core.agency,
  p_officer_id uuid,
  p_reason_code text,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_now timestamptz := transaction_timestamp();
  v_target public_core.officer_accounts;
  v_revoked integer;
BEGIN
  PERFORM public_core.officer_private_authorize_admin(p_actor_id, p_agency);
  PERFORM public_core.officer_private_assert_correlation(p_correlation_id);

  IF p_reason_code IS NULL OR NOT (p_reason_code = ANY(ARRAY['DEVICE_LOST', 'SECURITY_CONCERN', 'OTHER'])) THEN
    RETURN public_core.officer_private_refused('INVALID_REASON');
  END IF;
  v_target := public_core.officer_private_lock_target(p_officer_id, p_agency);
  IF v_target.officer_id IS NULL THEN
    RETURN public_core.officer_private_refused('NOT_FOUND');
  END IF;
  IF v_target.officer_id = p_actor_id THEN
    RETURN public_core.officer_private_refused('SELF_MODIFICATION');
  END IF;

  v_revoked := public_core.officer_private_revoke_sessions(v_target.officer_id, 'SESSIONS_REVOKED', v_now);
  PERFORM public_core.officer_private_stage_audit(
    'OFFICER_SESSIONS_REVOKED', v_target.officer_id, p_actor_id, p_agency, p_correlation_id,
    jsonb_build_object('reasonCode', p_reason_code, 'sessionsRevoked', v_revoked),
    v_now
  );
  RETURN jsonb_build_object('outcome', 'REVOKED', 'officer', public_core.officer_private_view(v_target.officer_id), 'sessionsRevoked', v_revoked);
END;
$function$;

-- The officer redeems their one-time code and sets their own password. Every
-- failure is the same REJECTED (no handle or code oracle).
CREATE OR REPLACE FUNCTION public_core.officer_activate(
  p_login_handle text,
  p_activation_code text,
  p_credential text,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_account public_core.officer_accounts;
  v_code public_core.officer_activation_codes;
BEGIN
  PERFORM public_core.officer_private_assert_iam_caller();
  PERFORM public_core.officer_private_assert_correlation(p_correlation_id);
  IF p_credential IS NULL OR p_credential NOT LIKE 'scrypt$%' THEN
    RAISE EXCEPTION 'activation requires a scrypt credential' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_account
  FROM public_core.officer_accounts AS oa
  WHERE oa.login_handle = lower(btrim(COALESCE(p_login_handle, '')))
  FOR UPDATE;
  IF NOT FOUND OR v_account.status <> 'pending' THEN
    RETURN jsonb_build_object('outcome', 'REJECTED');
  END IF;

  SELECT * INTO v_code
  FROM public_core.officer_activation_codes AS ac
  WHERE ac.officer_id = v_account.officer_id
  FOR UPDATE;
  IF NOT FOUND OR v_code.redeemed_at IS NOT NULL OR v_code.released_at IS NULL OR v_code.expires_at <= v_now
     OR v_code.code_hash IS DISTINCT FROM public_core.officer_private_code_hash(p_activation_code) THEN
    RETURN jsonb_build_object('outcome', 'REJECTED');
  END IF;

  UPDATE public_core.officer_activation_codes SET redeemed_at = v_now WHERE officer_id = v_account.officer_id;
  UPDATE public_core.officer_accounts
  SET credential = p_credential, status = 'active', activated_at = v_now
  WHERE officer_id = v_account.officer_id;

  PERFORM public_core.officer_private_stage_audit(
    'OFFICER_ACTIVATED', v_account.officer_id, v_account.officer_id, v_account.agency, p_correlation_id,
    jsonb_build_object('method', 'ONE_TIME_ACTIVATION_CODE'),
    v_now
  );
  RETURN jsonb_build_object('outcome', 'ACTIVATED');
END;
$function$;

-- Stamp a successful login (listOfficers shows it). Active accounts only.
CREATE OR REPLACE FUNCTION public_core.officer_record_login(p_officer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM public_core.officer_private_assert_iam_caller();
  UPDATE public_core.officer_accounts
  SET last_login_at = clock_timestamp()
  WHERE officer_id = p_officer_id AND status = 'active';
END;
$function$;

-- ── Ownership and EXECUTE ─────────────────────────────────────────
ALTER FUNCTION public_core.officer_private_assert_iam_caller() OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_private_authorize_admin(uuid, public_core.agency) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_private_assert_correlation(text) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_private_posts_refusal(text[]) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_private_sorted(text[]) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_private_normalise_code(text) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_private_code_hash(text) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_private_open_activation(uuid, uuid, timestamptz) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_private_revoke_sessions(uuid, text, timestamptz) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_private_stage_audit(text, uuid, uuid, public_core.agency, text, jsonb, timestamptz) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_private_view(uuid) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_private_lock_target(uuid, public_core.agency) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_private_refused(text) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_list(uuid, public_core.agency) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_create(uuid, public_core.agency, text, text[], text) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_reissue_activation(uuid, public_core.agency, uuid, text) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_release_activation(uuid, public_core.agency, uuid, text) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_assign_posts(uuid, public_core.agency, uuid, text[], text, text) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_set_status(uuid, public_core.agency, uuid, text, text, text) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_revoke_sessions(uuid, public_core.agency, uuid, text, text) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_activate(text, text, text, text) OWNER TO usrp_officer_command_owner;
ALTER FUNCTION public_core.officer_record_login(uuid) OWNER TO usrp_officer_command_owner;

REVOKE ALL ON FUNCTION public_core.officer_private_assert_iam_caller() FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_private_authorize_admin(uuid, public_core.agency) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_private_assert_correlation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_private_posts_refusal(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_private_sorted(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_private_normalise_code(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_private_code_hash(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_private_open_activation(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_private_revoke_sessions(uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_private_stage_audit(text, uuid, uuid, public_core.agency, text, jsonb, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_private_view(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_private_lock_target(uuid, public_core.agency) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_private_refused(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_list(uuid, public_core.agency) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_create(uuid, public_core.agency, text, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_reissue_activation(uuid, public_core.agency, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_release_activation(uuid, public_core.agency, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_assign_posts(uuid, public_core.agency, uuid, text[], text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_set_status(uuid, public_core.agency, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_revoke_sessions(uuid, public_core.agency, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_activate(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_core.officer_record_login(uuid) FROM PUBLIC;

-- usrp_iam_service alone may call the public functions; agency officer roles,
-- the system role and the edge role may not.
GRANT EXECUTE ON FUNCTION
  public_core.officer_list(uuid, public_core.agency),
  public_core.officer_create(uuid, public_core.agency, text, text[], text),
  public_core.officer_reissue_activation(uuid, public_core.agency, uuid, text),
  public_core.officer_release_activation(uuid, public_core.agency, uuid, text),
  public_core.officer_assign_posts(uuid, public_core.agency, uuid, text[], text, text),
  public_core.officer_set_status(uuid, public_core.agency, uuid, text, text, text),
  public_core.officer_revoke_sessions(uuid, public_core.agency, uuid, text, text),
  public_core.officer_activate(text, text, text, text),
  public_core.officer_record_login(uuid)
  TO usrp_iam_service;

-- The owner needs CREATE only while ownership is assigned above.
REVOKE CREATE ON SCHEMA public_core FROM usrp_officer_command_owner;

COMMIT;
