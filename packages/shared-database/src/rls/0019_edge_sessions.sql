-- 0019 — durable edge session store (ADR-021)
--
-- This file is intentionally safe against both an empty database and the
-- earlier development version of edge_sessions. The first runtime prototype
-- created the table with credential_ciphertext/csrf_token and no rotation
-- columns; CREATE TABLE IF NOT EXISTS alone cannot evolve that table.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usrp_edge_gateway') THEN
    CREATE ROLE usrp_edge_gateway NOLOGIN;
  END IF;
END
$$;

GRANT usrp_edge_gateway TO usrp_app;
GRANT USAGE ON SCHEMA public_core TO usrp_edge_gateway;

CREATE TABLE IF NOT EXISTS public_core.edge_sessions (
  session_id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  handle_hash               varchar(64)  UNIQUE NOT NULL,
  previous_handle_hash      varchar(64),
  previous_csrf_token_hash  varchar(64),
  previous_valid_until      timestamptz,
  csrf_token_hash           varchar(64)  NOT NULL,
  kind                      varchar(16)  NOT NULL CHECK (kind IN ('officer', 'applicant')),
  subject_id                uuid,
  agency                    public_core.agency,
  roles                     text[]       NOT NULL DEFAULT '{}',
  upstream_credential       text         NOT NULL,
  upstream_expires_at       timestamptz,
  issued_at                 timestamptz  NOT NULL DEFAULT now(),
  idle_expires_at           timestamptz  NOT NULL,
  absolute_expires_at       timestamptz  NOT NULL,
  last_seen_at              timestamptz  NOT NULL DEFAULT now(),
  rotated_at                timestamptz,
  revoked_at                timestamptz,
  revoked_reason            varchar(32),
  CONSTRAINT edge_sessions_officer_shape CHECK (
    (kind = 'officer' AND agency IS NOT NULL AND subject_id IS NOT NULL)
    OR (kind = 'applicant' AND agency IS NULL)
  ),
  CONSTRAINT edge_sessions_ttl_order CHECK (absolute_expires_at >= idle_expires_at)
);

-- Compatibility bridge for the original local/dev 0019 shape. All old rows
-- are made non-live during the bridge because their CSRF value was plaintext,
-- not the keyed hash required by the current store.
DO $$
DECLARE
  subject_type text;
  roles_type text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public_core' AND table_name = 'edge_sessions'
      AND column_name = 'credential_ciphertext'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public_core' AND table_name = 'edge_sessions'
      AND column_name = 'upstream_credential'
  ) THEN
    ALTER TABLE public_core.edge_sessions RENAME COLUMN credential_ciphertext TO upstream_credential;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public_core' AND table_name = 'edge_sessions'
      AND column_name = 'credential_expires_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public_core' AND table_name = 'edge_sessions'
      AND column_name = 'upstream_expires_at'
  ) THEN
    ALTER TABLE public_core.edge_sessions RENAME COLUMN credential_expires_at TO upstream_expires_at;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public_core' AND table_name = 'edge_sessions'
      AND column_name = 'created_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public_core' AND table_name = 'edge_sessions'
      AND column_name = 'issued_at'
  ) THEN
    ALTER TABLE public_core.edge_sessions RENAME COLUMN created_at TO issued_at;
  END IF;

  ALTER TABLE public_core.edge_sessions
    ADD COLUMN IF NOT EXISTS session_id uuid DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS previous_handle_hash varchar(64),
    ADD COLUMN IF NOT EXISTS previous_csrf_token_hash varchar(64),
    ADD COLUMN IF NOT EXISTS previous_valid_until timestamptz,
    ADD COLUMN IF NOT EXISTS csrf_token_hash varchar(64),
    ADD COLUMN IF NOT EXISTS upstream_credential text,
    ADD COLUMN IF NOT EXISTS upstream_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS issued_at timestamptz DEFAULT now(),
    ADD COLUMN IF NOT EXISTS rotated_at timestamptz,
    ADD COLUMN IF NOT EXISTS revoked_reason varchar(32);

  -- Legacy rows cannot be safely re-authenticated with their old plaintext
  -- csrf_token. Revoke them before assigning the impossible sentinel hash.
  UPDATE public_core.edge_sessions
  SET revoked_at = COALESCE(revoked_at, now()),
      revoked_reason = COALESCE(revoked_reason, 'legacy_schema'),
      csrf_token_hash = COALESCE(csrf_token_hash, repeat('0', 64))
  WHERE csrf_token_hash IS NULL;

  UPDATE public_core.edge_sessions
  SET session_id = gen_random_uuid()
  WHERE session_id IS NULL;

  SELECT data_type INTO subject_type
  FROM information_schema.columns
  WHERE table_schema = 'public_core' AND table_name = 'edge_sessions'
    AND column_name = 'subject_id';
  IF subject_type IN ('text', 'character varying') THEN
    ALTER TABLE public_core.edge_sessions
      ALTER COLUMN subject_id TYPE uuid
      USING CASE
        WHEN subject_id IS NULL OR subject_id = '' THEN NULL
        WHEN subject_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN subject_id::uuid
        ELSE NULL
      END;
  END IF;

  SELECT data_type INTO roles_type
  FROM information_schema.columns
  WHERE table_schema = 'public_core' AND table_name = 'edge_sessions'
    AND column_name = 'roles';
  IF roles_type = 'jsonb' THEN
    ALTER TABLE public_core.edge_sessions
      ALTER COLUMN roles TYPE text[]
      USING COALESCE(ARRAY(SELECT jsonb_array_elements_text(roles)), '{}'::text[]);
  END IF;

  ALTER TABLE public_core.edge_sessions
    ALTER COLUMN session_id SET NOT NULL,
    ALTER COLUMN csrf_token_hash SET NOT NULL,
    ALTER COLUMN upstream_credential SET NOT NULL,
    ALTER COLUMN issued_at SET NOT NULL,
    ALTER COLUMN roles SET NOT NULL,
    ALTER COLUMN roles SET DEFAULT '{}';

  -- Remove old NOT NULL columns after their values have been superseded.
  ALTER TABLE public_core.edge_sessions
    DROP COLUMN IF EXISTS csrf_token,
    DROP COLUMN IF EXISTS created_at;

  -- Replace the original handle primary key with the current session id key.
  ALTER TABLE public_core.edge_sessions DROP CONSTRAINT IF EXISTS edge_sessions_pkey;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public_core.edge_sessions'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE public_core.edge_sessions ADD CONSTRAINT edge_sessions_pkey PRIMARY KEY (session_id);
  END IF;
END
$$;

-- Ensure current constraints exist when the table came from the prototype.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edge_sessions_officer_shape') THEN
    ALTER TABLE public_core.edge_sessions ADD CONSTRAINT edge_sessions_officer_shape CHECK (
      (kind = 'officer' AND agency IS NOT NULL AND subject_id IS NOT NULL)
      OR (kind = 'applicant' AND agency IS NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edge_sessions_ttl_order') THEN
    ALTER TABLE public_core.edge_sessions ADD CONSTRAINT edge_sessions_ttl_order
      CHECK (absolute_expires_at >= idle_expires_at);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_pc_edge_sessions_prev_handle
  ON public_core.edge_sessions (previous_handle_hash)
  WHERE previous_handle_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pc_edge_sessions_absolute
  ON public_core.edge_sessions (absolute_expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public_core.edge_sessions TO usrp_edge_gateway;

ALTER TABLE public_core.edge_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.edge_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pc_edge_sessions_edge ON public_core.edge_sessions;
CREATE POLICY pc_edge_sessions_edge ON public_core.edge_sessions
  TO usrp_edge_gateway USING (true) WITH CHECK (true);

COMMIT;
