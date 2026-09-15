-- 0019 — RLS policy and grants for edge_sessions (ADR-021)
--
-- Table creation now lives in migrations/0001_create_edge_sessions.sql,
-- tracked by drizzle-kit. This file only sets up the role, grants, and
-- row-level security policy — it assumes the table already exists.
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
GRANT SELECT, INSERT, UPDATE, DELETE ON public_core.edge_sessions TO usrp_edge_gateway;

ALTER TABLE public_core.edge_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.edge_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pc_edge_sessions_edge ON public_core.edge_sessions;
CREATE POLICY pc_edge_sessions_edge ON public_core.edge_sessions
  TO usrp_edge_gateway USING (true) WITH CHECK (true);

COMMIT;