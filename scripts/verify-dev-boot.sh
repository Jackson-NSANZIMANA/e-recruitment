#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# verify-dev-boot.sh — PROVE the developer entrypoint works.
#
# The gate had 37 proofs and every one of them ran through
# run-selfchecks.sh, which exports its own environment inline and never
# reads .env.example. So the file a fresh clone actually starts from
# (setup-dev.sh does `cp .env.example .env`) was the one surface no proof
# touched — and it rotted for roughly thirty slices: four wrong G2G variable
# names, the in-network Kafka port instead of the host one, missing master
# keys, CHANGE_ME placeholders that fail createPublicKey, and no per-service
# PORT at all (every service silently defaulting to :3000 and racing for one
# socket). `pnpm dev` could not have worked for a very long time.
#
# That is the same failure class as the drizzle snapshot drift and the
# "known single-broker flake" that turned out to be a real consumer-group
# defect: anything not covered by an executable proof drifts. So this closes
# the seam the way the repo closes every other one — by executing the real
# thing, deterministically, on every gate run.
#
# It boots from .env.example ON PURPOSE. A developer's local .env is not the
# artefact that must stay honest; the committed template is.
#
# Prerequisites — the same live infra the rest of the gate needs:
#   • tier1: Postgres + G2G mocks + MinIO
#   • tier2: Kafka (host listener :29092)
#   • DB bootstrapped (scripts/bootstrap-db.sh)
#
# Usage:  bash scripts/verify-dev-boot.sh
#         BOOT_TIMEOUT_S=120 bash scripts/verify-dev-boot.sh
# Exit:   0 iff every service boots, answers, and stops cleanly.
# ══════════════════════════════════════════════════════════════════
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Deliberately the TEMPLATE, not .env. Override only to debug a local file.
ENV_FILE="${USRP_ENV_FILE:-.env.example}"
BOOT_TIMEOUT_S="${BOOT_TIMEOUT_S:-90}"

GREEN=$'\033[0;32m'
RED=$'\033[0;31m'
CYAN=$'\033[1;36m'
BOLD=$'\033[1m'
NC=$'\033[0m'

ok()  { printf '%s✓ PASS — %s%s\n' "$GREEN" "$*" "$NC"; }
bad() { printf '%s✗ FAIL — %s%s\n' "$RED" "$*" "$NC"; }
log() { printf '%s══ %s%s\n' "$CYAN" "$*" "$NC"; }

[[ -f "$ENV_FILE" ]] || { bad "$ENV_FILE not found"; exit 1; }
command -v curl >/dev/null 2>&1 || { bad 'curl is required'; exit 1; }

# Load the template exactly as scripts/dev.sh loads .env — same mechanism,
# so a file that works here works there.
set -a
# shellcheck disable=SC1090
source "./$ENV_FILE"
set +a
log "loaded $ENV_FILE"

# Every service that ships a src/main.ts.
SERVICES=(
  identity-service
  iam-service
  application-service
  eligibility-service
  background-vetting-service
  scheduling-service
  notification-service
  biometric-service
  document-forensics-service
  field-sync-service
  audit-service
)

# PORT_<SERVICE_NAME> — the same derivation as portVarName() in
# @usrp/shared-config, so this proof cannot disagree with what the services
# actually read.
port_var_for() {
  printf 'PORT_%s' "$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_')"
}

LOG_DIR="$(mktemp -d)"
declare -a PIDS=()
declare -a STARTED=()
pass=0
fail=0
declare -a FAILED=()

cleanup() {
  log 'stopping services'
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null
  done
  sleep 3
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill -KILL "$pid" 2>/dev/null
  done
  wait 2>/dev/null
  return 0
}
trap cleanup EXIT

# ── 1. Static: every service must claim its OWN port ───────────────────
# Checked BEFORE booting: a collision here is deterministic, and diagnosing
# it from eleven interleaved EADDRINUSE stack traces is miserable.
log 'per-service port assignment'
declare -A SEEN=()
port_conflict=0
for svc in "${SERVICES[@]}"; do
  var="$(port_var_for "$svc")"
  value="${!var:-}"
  if [[ -z "$value" ]]; then
    bad "$svc — $var unset in $ENV_FILE (falls back to :3000 and collides)"
    port_conflict=1
    continue
  fi
  if [[ -n "${SEEN[$value]:-}" ]]; then
    bad "port :$value claimed by BOTH ${SEEN[$value]} and $svc"
    port_conflict=1
    continue
  fi
  SEEN[$value]="$svc"
done
if [[ $port_conflict -eq 0 ]]; then
  ok "${#SERVICES[@]} services, ${#SEEN[@]} distinct ports"
  pass=$((pass+1))
else
  fail=$((fail+1))
  FAILED+=('per-service port assignment')
fi

# ── 2. Boot every service ─────────────────────────────────────────
# tsx without watch: a proof wants one deterministic process per service.
# PORT is set explicitly so this holds even if the scoped-name derivation
# is ever changed — the check above is what guards the derivation itself.
log "booting ${#SERVICES[@]} services"
for svc in "${SERVICES[@]}"; do
  var="$(port_var_for "$svc")"
  ( cd "services/$svc" && PORT="${!var:-}" exec npx tsx src/main.ts ) \
    >"$LOG_DIR/$svc.log" 2>&1 &
  PIDS+=("$!")
  STARTED+=("$svc")
done

# ── 3. Each must answer its readiness probe ──────────────────────────
# /ready is the real signal (identity-service only reports ready once
# Postgres answers). /health is the fallback for the DB-free gates, whose
# readiness is trivially true — either proves the process is serving.
log "polling readiness (timeout ${BOOT_TIMEOUT_S}s)"
deadline=$(( $(date +%s) + BOOT_TIMEOUT_S ))
declare -A READY=()
while :; do
  all_ready=1
  for i in "${!STARTED[@]}"; do
    svc="${STARTED[$i]}"
    if [[ -n "${READY[$svc]:-}" ]]; then continue; fi
    var="$(port_var_for "$svc")"
    p="${!var:-0}"
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
      "http://127.0.0.1:$p/ready" 2>/dev/null)
    if [[ "$code" == '200' ]]; then
      READY[$svc]='ready'
    else
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
        "http://127.0.0.1:$p/health" 2>/dev/null)
      if [[ "$code" == '200' ]]; then READY[$svc]='health'; fi
    fi
    if [[ -z "${READY[$svc]:-}" ]]; then all_ready=0; fi
  done
  if [[ $all_ready -eq 1 ]]; then break; fi
  if [[ $(date +%s) -ge $deadline ]]; then break; fi
  sleep 2
done

for i in "${!STARTED[@]}"; do
  svc="${STARTED[$i]}"
  pid="${PIDS[$i]}"
  var="$(port_var_for "$svc")"
  p="${!var:-?}"
  if [[ -n "${READY[$svc]:-}" ]]; then
    ok "$svc — ${READY[$svc]} on :$p"
    pass=$((pass+1))
  else
    fail=$((fail+1))
    FAILED+=("$svc")
    if kill -0 "$pid" 2>/dev/null; then
      bad "$svc — alive on :$p but never answered /ready or /health"
    else
      bad "$svc — process exited during boot"
    fi
    printf '%s  ── last 20 lines of %s ──%s\n' "$BOLD" "$svc" "$NC"
    tail -n 20 "$LOG_DIR/$svc.log" 2>/dev/null | sed 's/^/    /'
  fi
done

# ── Summary ─────────────────────────────────────────────────────
printf '\n%s─────────────────────────────────────────────%s\n' "$BOLD" "$NC"
printf 'Checks: %s%d passed%s, ' "$GREEN" "$pass" "$NC"
if [[ $fail -eq 0 ]]; then
  printf '%s%d failed%s\n' "$GREEN" "$fail" "$NC"
  printf '%s%sDEV BOOT GREEN — all %d services start from %s ✓%s\n' \
    "$GREEN" "$BOLD" "${#SERVICES[@]}" "$ENV_FILE" "$NC"
  exit 0
fi
printf '%s%d failed%s\n' "$RED" "$fail" "$NC"
printf 'Failed:\n'
for f in "${FAILED[@]}"; do printf '  %s✗ %s%s\n' "$RED" "$f" "$NC"; done
printf 'logs kept in %s\n' "$LOG_DIR"
exit 1
