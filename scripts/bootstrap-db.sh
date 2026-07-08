#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# bootstrap-db.sh — bring an EMPTY Postgres to the fully-provisioned,
# proven USRP state, in the ONE canonical order. Idempotent: safe to
# re-run. This codifies what was previously tribal knowledge scattered
# across slice docs — the sequence every developer and CI must follow:
#
#   1. db:migrate      — drizzle applies the schema (5 schemas, tables)
#   2. rls/0001        — group roles, grants, FORCE'd RLS on identities
#   3. rls/0002        — audit-log immutability (writer role + triggers)
#   4. rls/0003        — per-agency processing-code sequences (front door)
#
# The schema migration runs as the admin/owner over DATABASE_URL; the
# role & RLS files are applied with psql as usrp_admin (they CREATE ROLE
# and ALTER TABLE, which require owner/superuser).
#
# Env (all have dev defaults so a plain run works against tier1):
#   DATABASE_URL   admin connection for drizzle-kit migrate
#   PG_CONTAINER   docker container running Postgres (default usrp-postgres)
#   PG_ADMIN_USER  superuser/owner for psql role+RLS files
#   PG_DB          database name
#
# Usage:  bash scripts/bootstrap-db.sh
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PKG="${REPO_ROOT}/packages/shared-database"
RLS_DIR="${DB_PKG}/src/rls"

DATABASE_URL="${DATABASE_URL:-postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db}"
PG_CONTAINER="${PG_CONTAINER:-usrp-postgres}"
PG_ADMIN_USER="${PG_ADMIN_USER:-usrp_admin}"
PG_DB="${PG_DB:-usrp_db}"

log()  { printf '\033[0;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Apply a .sql file as usrp_admin inside the PG container, aborting on any error.
apply_sql() {
  local file="$1" label="$2"
  [[ -f "$file" ]] || fail "missing SQL file: $file"
  log "applying $label"
  if docker exec -i "$PG_CONTAINER" psql -U "$PG_ADMIN_USER" -d "$PG_DB" \
       -v ON_ERROR_STOP=1 -q < "$file"; then
    ok "$label applied"
  else
    fail "$label FAILED"
  fi
}

log "USRP database bootstrap → ${PG_DB} (container ${PG_CONTAINER})"

# 1. Schema migration (drizzle-kit, as admin over DATABASE_URL).
log "db:migrate (drizzle-kit)"
DATABASE_URL="$DATABASE_URL" pnpm --filter @usrp/shared-database db:migrate \
  || fail "db:migrate FAILED"
ok "schema migrated"

# 2. Roles, grants, FORCE'd RLS (the cross-agency isolation surface).
apply_sql "${RLS_DIR}/0001_roles_grants_rls.sql" "rls/0001 (roles + RLS)"

# 3. Audit-log immutability (INSERT-only writer role + reject-mutation triggers).
apply_sql "${RLS_DIR}/0002_audit_immutability.sql" "rls/0002 (audit immutability)"

# 4. Per-agency processing-code sequences (the front door mints AGENCY-XXXXX).
apply_sql "${RLS_DIR}/0003_processing_code_sequences.sql" "rls/0003 (processing-code sequences)"

# 5. Campaign read grant (the front door resolves the open campaign server-side).
apply_sql "${RLS_DIR}/0004_campaign_read_grants.sql" "rls/0004 (campaign read grant)"

# 6. G2G subject-hash column (identity-service writes it; HEC/RIB re-present it).
apply_sql "${RLS_DIR}/0005_nida_lookup_hash.sql" "rls/0005 (g2g subject hash column)"

# 7. Age eligibility columns on all 3 ops schemas (the third projected vetting
#    dimension → lets the projection reach DOCUMENT_REVIEW_GREEN; see ADR-007).
apply_sql "${RLS_DIR}/0006_age_eligibility_columns.sql" "rls/0006 (age eligibility columns)"

printf '\n'
ok "database bootstrapped — schema + isolation + audit immutability + processing codes + campaign reads + g2g subject hash + age columns in place"
