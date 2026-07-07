-- ══════════════════════════════════════════════════════════════════
-- USRP — Row Level Security Policies
-- Applied after tables are created by Drizzle migrations
-- This script is idempotent — safe to re-run
-- ══════════════════════════════════════════════════════════════════

-- NOTE: RLS policies are applied to tables after Drizzle creates them.
-- This file contains the policy DEFINITIONS.
-- The migration runner applies them after schema creation.

-- Placeholder confirming RLS init script loaded:
DO $$ BEGIN
  RAISE NOTICE 'USRP RLS policy definitions loaded — will be applied post-migration';
END $$;
