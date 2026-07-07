-- ══════════════════════════════════════════════════════════════════
-- USRP — PostgreSQL Extensions
-- Run order: 04 (after schemas, roles, RLS)
-- ══════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- Confirm extensions
SELECT extname, extversion FROM pg_extension ORDER BY extname;
