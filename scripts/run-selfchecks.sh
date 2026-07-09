#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# run-selfchecks.sh — run EVERY proof in the repo, in dependency order,
# against live infrastructure. This is the project's real quality gate:
# "prove it, don't assert it" made repeatable and enforceable (CI runs
# this same script). A regression in any invariant — cross-agency
# isolation, PII protection, audit immutability, the event backbone —
# turns this red.
#
# Prerequisites (the caller brings the infra up and bootstraps the DB):
#   • tier1: Postgres + NIDA mock (:3100) + NESA mock (:3101)
#   • tier2: Kafka (host listener :29092)
#   • DB already bootstrapped (scripts/bootstrap-db.sh)
#
# Dev secrets are the well-known non-production values used across all
# selfcheck docs; centralised here so every proof runs with one env.
#
# Usage:  bash scripts/run-selfchecks.sh
# Exit:   0 iff every proof passes; first failure aborts (fail-fast).
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Shared dev environment (non-production, matches the slice docs) ──
export DATABASE_URL="${DATABASE_URL:-postgresql://usrp_app:app_pw@localhost:5432/usrp_db}"
export KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:29092}"
export NIDA_BASE_URL="${NIDA_BASE_URL:-http://localhost:3100}"
export NIDA_HMAC_SECRET="${NIDA_HMAC_SECRET:-dev_nida_hmac_secret}"
export NESA_BASE_URL="${NESA_BASE_URL:-http://localhost:3101}"
export NESA_HMAC_SECRET="${NESA_HMAC_SECRET:-dev_nesa_hmac_secret}"
export HEC_BASE_URL="${HEC_BASE_URL:-http://localhost:3103}"
export HEC_HMAC_SECRET="${HEC_HMAC_SECRET:-dev_hec_hmac_secret}"
export RIB_BASE_URL="${RIB_BASE_URL:-http://localhost:3102}"
export RIB_HMAC_SECRET="${RIB_HMAC_SECRET:-dev_rib_hmac_secret}"
export NATIONAL_ID_HMAC_KEY="${NATIONAL_ID_HMAC_KEY:-dev_national_id_hmac_key_min_32_chars!!}"
export PII_ENCRYPTION_KEY="${PII_ENCRYPTION_KEY:-dev_pii_encryption_key_min_32_chars_ok!!}"

PG_CONTAINER="${PG_CONTAINER:-usrp-postgres}"
PG_ADMIN_USER="${PG_ADMIN_USER:-usrp_admin}"
PG_DB="${PG_DB:-usrp_db}"

pass=0
fail=0
declare -a FAILED=()

hdr()  { printf '\n\033[1;36m══ %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m✓ PASS — %s\033[0m\n' "$*"; pass=$((pass+1)); }
bad()  { printf '\033[0;31m✗ FAIL — %s\033[0m\n' "$*"; fail=$((fail+1)); FAILED+=("$1"); }

# Run a tsx selfcheck; $1 = human label, $2 = path.
run_ts() {
  local label="$1" path="$2"
  hdr "$label"
  if npx tsx "$path"; then ok "$label"; else bad "$label"; fi
}

# ── 1. Cross-agency isolation — the system's first hard invariant ──
# Runs as usrp_admin inside the PG container; rolls back; ERRORs on any leak.
hdr "RLS cross-agency isolation (verify-isolation.sql)"
if docker exec -i "$PG_CONTAINER" psql -U "$PG_ADMIN_USER" -d "$PG_DB" \
     -v ON_ERROR_STOP=1 -q < packages/shared-database/src/rls/verify-isolation.sql; then
  ok "RLS cross-agency isolation"
else
  bad "RLS cross-agency isolation"
fi

# ── 2. The service & backbone selfchecks, in dependency order ──────
run_ts "shared-events: Kafka round-trip"          packages/shared-events/selfcheck/verify-kafka-roundtrip.ts
run_ts "identity-service: core slice"             services/identity-service/selfcheck/verify-slice.ts
run_ts "identity-service: HTTP slice"             services/identity-service/selfcheck/verify-http-slice.ts
run_ts "application-service: front-door submit"   services/application-service/selfcheck/verify-submit-http-slice.ts
run_ts "application-service: lifecycle monotonicity" services/application-service/selfcheck/verify-lifecycle.ts
run_ts "application-service: vetting projection"   services/application-service/selfcheck/verify-vetting-projection.ts
run_ts "application-service: history immutability" services/application-service/selfcheck/verify-history-immutability.ts
run_ts "eligibility-service: age gate"            services/eligibility-service/selfcheck/verify-age-eligibility.ts
run_ts "eligibility-service: NESA education gate" services/eligibility-service/selfcheck/verify-education-eligibility.ts
run_ts "eligibility-service: HEC degree gate"     services/eligibility-service/selfcheck/verify-degree-eligibility.ts
run_ts "eligibility-service: event-driven age+academic" services/eligibility-service/selfcheck/verify-event-driven.ts
run_ts "background-vetting: RIB criminal gate"    services/background-vetting-service/selfcheck/verify-vetting-slice.ts
run_ts "scheduling-service: slot assignment"      services/scheduling-service/selfcheck/verify-slot-assignment.ts
run_ts "audit-service: immutable trail"           services/audit-service/selfcheck/verify-audit-slice.ts
# The whole spine composed: one real submission → all 3 gates → DOCUMENT_REVIEW_GREEN.
# Runs last — it exercises the most services (eligibility + background-vetting + application).
run_ts "pipeline: full chain → DOCUMENT_REVIEW_GREEN" services/application-service/selfcheck/verify-pipeline-e2e.ts

# ── Summary ────────────────────────────────────────────────────────
printf '\n\033[1m─────────────────────────────────────────────\033[0m\n'
printf 'Proofs: \033[0;32m%d passed\033[0m, ' "$pass"
if [[ $fail -eq 0 ]]; then
  printf '\033[0;32m%d failed\033[0m\n' "$fail"
  printf '\033[1;32mALL PROOFS GREEN — every invariant holds ✓\033[0m\n'
  exit 0
else
  printf '\033[0;31m%d failed\033[0m\n' "$fail"
  printf 'Failed proofs:\n'
  for f in "${FAILED[@]}"; do printf '  \033[0;31m✗ %s\033[0m\n' "$f"; done
  exit 1
fi
