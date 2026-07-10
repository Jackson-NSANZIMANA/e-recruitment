-- ══════════════════════════════════════════════════════════════════
-- USRP — Row Level Security Policies
-- Applied after tables are created by Drizzle migrations
-- This script is idempotent — safe to re-run
-- ══════════════════════════════════════════════════════════════════

-- NOTE: RLS policies are applied to tables after Drizzle creates them.
-- The AUTHORITATIVE policy definitions live in
--   packages/shared-database/src/rls/0001_roles_grants_rls.sql (+ 0002..)
-- and are applied by scripts/bootstrap-db.sh AFTER `pnpm db:migrate` creates
-- the tables. This init-script intentionally stays a no-op placeholder so the
-- rls/* migrations remain the single source of truth for grants + policies.

-- Placeholder confirming RLS init script loaded:
DO $$ BEGIN
  RAISE NOTICE 'USRP RLS policy definitions loaded — will be applied post-migration';
END $$;
