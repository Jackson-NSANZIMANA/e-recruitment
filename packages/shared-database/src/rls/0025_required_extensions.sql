-- ══════════════════════════════════════════════════════════════════
-- rls/0025_required_extensions.sql
-- Provision the extensions the SCHEMA and runtime actually depend on,
-- through the canonical migration path.
--
-- WHY THIS FILE EXISTS (a real defect, found by review):
-- pgcrypto was previously provisioned ONLY by
-- infrastructure/docker/init-scripts/04-create-extensions.sql — a
-- docker-ENTRYPOINT script that runs once, and only when the postgres
-- container's data directory is empty. Every other deployment target
-- (a fresh database on an existing cluster, a managed Postgres, a
-- restored backup) skipped it silently, and then identity-service's
-- pgp_sym_encrypt calls failed at RUNTIME with 42883 "function does
-- not exist" — a provisioning gap that first surfaced as a proof
-- crash on a re-initdb'd sandbox database that had never run the
-- compose init scripts.
--
-- The database's own dependency is therefore declared where the
-- database's own changes live: here. Idempotent (IF NOT EXISTS), so
-- the compose path that already created it is unaffected.
--
-- Scope: ONLY pgcrypto. The init script also creates uuid-ossp,
-- pg_stat_statements (and the image bundles pg_trgm/btree_gin), but
-- nothing in this repository uses uuid_generate_v4 (gen_random_uuid
-- is core since PG13), pg_trgm or btree_gin operators — and
-- pg_stat_statements needs shared_preload_libraries, so creating it
-- from a migration could BREAK bootstrap on targets that have not
-- preconfigured it. Extensions nobody calls are not provisioned;
-- the one the PII envelope calls on every write is.
-- ══════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

COMMENT ON EXTENSION pgcrypto IS
  'Required by the PII envelope (pgp_sym_encrypt/pgp_sym_decrypt in identity- and application-service repositories and rls/verify-isolation.sql). Provisioned by the canonical migration path since rls/0025; previously only by the compose container init script.';