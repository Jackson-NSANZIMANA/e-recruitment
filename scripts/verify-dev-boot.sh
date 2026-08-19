#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# verify-dev-boot.sh — PROVE the developer entrypoint works, BY RUNNING IT.
#
# The gate had 37 proofs and every one of them ran through run-selfchecks.sh,
# which exports its own environment inline and never reads .env.example. So
# the file a fresh clone actually starts from (setup-dev.sh does
# `cp .env.example .env`) was the one surface no proof touched, and it rotted
# for roughly thirty slices.
#
# THIS PROOF EXECUTES THE REAL PATH — not a stand-in for it. The first version
# of this file used a stand-in, and it was unsound in three ways that each let
# the defect it guards walk straight back in:
#
#   1. It ran `npx tsx src/main.ts` per service. That skips scripts/dev.sh (the
#      env-loading boundary) AND `turbo run dev --parallel` (Turbo 2.x strict
#      env mode). Those two ARE defect 1. A proof that bypasses both cannot
#      see it regress.
#   2. It passed PORT= explicitly to each child, overriding the
#      PORT_<SERVICE_NAME> derivation in loadRuntimeConfig — which IS defect 3.
#      It asserted a value it had itself supplied.
#   3. It inherited run-selfchecks.sh's exported environment. Under
#      `pnpm verify` the parent exports DATABASE_URL, KAFKA_BROKERS, the four
#      G2G names, both master keys and the auth keypair. Sourcing the template
#      on top of that means a variable MISSING from .env.example is silently
#      supplied by the gate: the proof goes GREEN on a template that cannot
#      boot a fresh clone. That is the exact lie it exists to prevent.
#
# So: sanitize the environment (env -i), load ONLY the template, and boot
# through `scripts/dev.sh` → turbo → tsx. If turbo.json's `env` allowlist
# loses a name, this goes red. That allowlist is 54 hand-maintained strings
# and nothing else in the repo executes it.
#
# Proven both directions before commit, as this repo requires:
#   • reconciled template ............................ green
#   • injected port collision ........................ red
#   • removed scoped variable ........................ red
#   • scoped port dropped from turbo.json ............ red  (new: strict-mode gap)
#   • variable absent from template but exported by
#     the gate ....................................... red  (new: sanitization)
#     ...and GREEN under USRP_BOOT_INHERIT_ENV=1, which is the hole itself.
#
# It boots from .env.example ON PURPOSE. A developer's local .env is not the
# artefact that must stay honest; the committed template is.
#
# Prerequisites — the same live infra the rest of the gate needs:
#   • tier1: Postgres + G2G mocks + MinIO
#   • tier2: Kafka (host listener :29092)
#   • DB bootstrapped (scripts/bootstrap-db.sh)
#   • workspace built (`pnpm build`) — services resolve @usrp/* from dist
#
# Usage:  bash scripts/verify-dev-boot.sh
#         BOOT_TIMEOUT_S=240 bash scripts/verify-dev-boot.sh
#         USRP_BOOT_INHERIT_ENV=1 bash scripts/verify-dev-boot.sh   # debug ONLY
# Exit:   0 iff every service boots on its OWN derived port and identifies
#         itself there.
# ══════════════════════════════════════════════════════════════════
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Deliberately the TEMPLATE, not .env. Override only to debug a local file.
ENV_FILE="${USRP_ENV_FILE:-.env.example}"
# Eleven tsx processes + turbo on a CI runner where Postgres, Kafka, MinIO,
# four G2G mocks and ClamAV are already resident. 90s was optimistic.
BOOT_TIMEOUT_S="${BOOT_TIMEOUT_S:-180}"
# Repo-relative ON PURPOSE. The first version wrote to `mktemp -d` and told the
# reader "logs kept in $LOG_DIR" — a directory the CI runner then discarded,
# which is exactly why the first red run of this proof was undiagnosable from
# the job output. Covered by the existing `*.log` ignore rule.
LOG_DIR="${USRP_BOOT_LOG_DIR:-$REPO_ROOT/.boot-logs}"
BOOT_LOG="$LOG_DIR/dev-boot.log"
INHERIT_ENV="${USRP_BOOT_INHERIT_ENV:-0}"

GREEN=$'\033[0;32m'
RED=$'\033[0;31m'
CYAN=$'\033[1;36m'
BOLD=$'\033[1m'
NC=$'\033[0m'

ok()  { printf '%s✓ PASS — %s%s\n' "$GREEN" "$*" "$NC"; }
bad() { printf '%s✗ FAIL — %s%s\n' "$RED" "$*" "$NC"; }
log() { printf '%s══ %s%s\n' "$CYAN" "$*" "$NC"; }

pass=0
fail=0
declare -a FAILED=()
note_pass() { ok "$1"; pass=$((pass + 1)); }
note_fail() { bad "$1"; fail=$((fail + 1)); FAILED+=("$1"); }

[[ -f "$ENV_FILE" ]] || { bad "$ENV_FILE not found"; exit 1; }
command -v curl >/dev/null 2>&1 || { bad 'curl is required'; exit 1; }

mkdir -p "$LOG_DIR"
: >"$BOOT_LOG"

# ── Service discovery ─────────────────────────────────────────────
# DERIVED from the filesystem, not a hard-coded list: a service added later is
# covered by this proof the day it ships a src/main.ts, instead of sitting
# outside the gate the way .env.example sat outside it for thirty slices.
declare -a SERVICES=()
for dir in services/*/; do
  svc="$(basename "$dir")"
  [[ -f "${dir}src/main.ts" ]] || continue
  SERVICES+=("$svc")
done

if [[ ${#SERVICES[@]} -eq 0 ]]; then
  bad 'no services/*/src/main.ts found — wrong working directory?'
  exit 1
fi

# PORT_<SERVICE_NAME>, byte-for-byte the derivation portVarName() uses in
# @usrp/shared-config (uppercase; every run of non-alphanumerics → one
# underscore), so this proof cannot disagree with what the services read.
port_var_for() {
  local up
  up="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | sed 's/[^A-Z0-9]\{1,\}/_/g')"
  printf 'PORT_%s' "$up"
}

# Read a value straight out of the TEMPLATE FILE — never from the live
# environment. Reading the environment is how contamination hides a missing
# variable. Strips one layer of surrounding quotes, matching `set -a; source`.
template_value() {
  local key="$1" raw
  raw="$(sed -n "s/^[[:space:]]*${key}=\(.*\)\$/\1/p" "$ENV_FILE" | tail -n 1)"
  raw="${raw%$'\r'}"
  if [[ ${#raw} -ge 2 && "$raw" == \'*\' ]]; then
    raw="${raw:1:${#raw}-2}"
  elif [[ ${#raw} -ge 2 && "$raw" == \"*\" ]]; then
    raw="${raw:1:${#raw}-2}"
  fi
  printf '%s' "$raw"
}

# ── 1. Static: the template assigns every service its OWN port ─────────
# Checked BEFORE booting: a collision here is deterministic, and diagnosing it
# from eleven interleaved EADDRINUSE stack traces is miserable.
log "per-service port assignment (read from $ENV_FILE)"
declare -A SEEN=()
declare -A PORT_OF=()
port_conflict=0
for svc in "${SERVICES[@]}"; do
  var="$(port_var_for "$svc")"
  value="$(template_value "$var")"
  if [[ -z "$value" ]]; then
    bad "$svc — $var unset in $ENV_FILE (falls back to :3000 and collides)"
    port_conflict=1
    continue
  fi
  if [[ ! "$value" =~ ^[0-9]+$ ]] || ((value < 1 || value > 65535)); then
    bad "$svc — $var is not a valid TCP port: '$value'"
    port_conflict=1
    continue
  fi
  if [[ -n "${SEEN[$value]:-}" ]]; then
    bad "port :$value claimed by BOTH ${SEEN[$value]} and $svc"
    port_conflict=1
    continue
  fi
  SEEN[$value]="$svc"
  PORT_OF[$svc]="$value"
done
if [[ $port_conflict -eq 0 ]]; then
  note_pass "${#SERVICES[@]} services, ${#SEEN[@]} distinct ports"
else
  note_fail 'per-service port assignment'
fi

# ── 2. Static: Turbo must be allowed to PASS each scoped port through ──
# Turbo 2.x strict env mode hands a task only the variables enumerated in its
# `env`. A scoped port present in the template but missing from turbo.json
# never reaches the service, which then silently resolves :3000 — defect 3,
# reintroduced by an edit to a JSON array. That array is hand-maintained and
# 54 entries long; this is the check that keeps it honest.
log 'turbo.json declares every scoped PORT on the dev task'
turbo_gap=0
for svc in "${SERVICES[@]}"; do
  var="$(port_var_for "$svc")"
  if ! grep -q "\"${var}\"" turbo.json; then
    bad "$svc — $var missing from turbo.json (strict env mode drops it → :3000)"
    turbo_gap=1
  fi
done
if [[ $turbo_gap -eq 0 ]]; then
  note_pass "turbo.json passes through all ${#SERVICES[@]} scoped ports"
else
  note_fail 'turbo.json scoped-PORT declarations'
fi

# Nothing below can succeed if the port contract is broken. Fail now, with a
# named cause, instead of after 180s of polling dead sockets.
if [[ $port_conflict -ne 0 || $turbo_gap -ne 0 ]]; then
  printf '\n%s─────────────────────────────────────────────%s\n' "$BOLD" "$NC"
  printf '%s%d failed%s — port contract is broken; not booting services.\n' "$RED" "$fail" "$NC"
  exit 1
fi

# ── 3. Boot through the REAL entrypoint, in a SANITIZED environment ────
# `pnpm dev` is `bash scripts/dev.sh`, which sources the env file and execs
# `turbo run dev --parallel`. We invoke exactly that, so the loading boundary
# AND Turbo's strict-mode allowlist are both under test. --ui=stream because
# turbo.json sets "ui": "tui", which is useless in a captured CI log.
#
# env -i is what makes this honest under `pnpm verify`: without it the gate's
# own exports stand in for anything the template forgot. Only what is needed
# to RUN node/pnpm/turbo is re-admitted — no USRP variable crosses this line
# except through $ENV_FILE.
declare -a LAUNCH=()
if [[ "$INHERIT_ENV" == '1' ]]; then
  log 'WARNING: USRP_BOOT_INHERIT_ENV=1 — inherited env can mask template gaps'
  # Still route through `env`: setsid is not a shell, so a bare VAR=value
  # prefix would be taken as a program name, not an assignment.
  LAUNCH+=(env)
else
  LAUNCH+=(env -i
    PATH="$PATH"
    HOME="$HOME"
    LANG="${LANG:-C.UTF-8}"
    TERM="${TERM:-dumb}"
    SHELL="${SHELL:-/bin/bash}"
  )
  [[ -n "${CI:-}" ]] && LAUNCH+=(CI="$CI")
  [[ -n "${TMPDIR:-}" ]] && LAUNCH+=(TMPDIR="$TMPDIR")
fi
LAUNCH+=(USRP_ENV_FILE="$ENV_FILE" bash scripts/dev.sh --ui=stream)

# Own the whole process group so turbo, its eleven tsx children and their file
# watchers all die with us. setsid makes the child its own group leader.
BOOT_PGID=''
if command -v setsid >/dev/null 2>&1; then
  setsid "${LAUNCH[@]}" >>"$BOOT_LOG" 2>&1 &
  BOOT_PGID=$!
else
  "${LAUNCH[@]}" >>"$BOOT_LOG" 2>&1 &
  BOOT_PGID=$!
  log 'setsid unavailable — falling back to single-PID teardown'
fi

cleanup() {
  log 'stopping services'
  if [[ -n "$BOOT_PGID" ]]; then
    kill -TERM "-$BOOT_PGID" 2>/dev/null || kill -TERM "$BOOT_PGID" 2>/dev/null
    for _ in $(seq 1 10); do
      kill -0 "-$BOOT_PGID" 2>/dev/null || kill -0 "$BOOT_PGID" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "-$BOOT_PGID" 2>/dev/null || kill -KILL "$BOOT_PGID" 2>/dev/null
  fi
  wait 2>/dev/null
  return 0
}
trap cleanup EXIT

log "booting ${#SERVICES[@]} services via scripts/dev.sh (timeout ${BOOT_TIMEOUT_S}s)"

# ── 4. Each service must answer, AS ITSELF, on its OWN derived port ────
# /ready is the real signal (DB-backed services only report ready once
# Postgres answers); /health is the fallback for the DB-free gates, whose
# readiness is trivially true.
#
# We assert the RESPONDING SERVICE'S NAME, which the first version could not:
# it proves identity-service is the process on :4001, not merely that
# something is. A swapped or mis-derived mapping is otherwise a silent
# misconfiguration that still shows eleven green ports.
declare -A READY=()
deadline=$(( $(date +%s) + BOOT_TIMEOUT_S ))
boot_died=0

probe() { curl -fsS --max-time 3 "http://127.0.0.1:$1$2" 2>/dev/null; }

while :; do
  all_ready=1
  for svc in "${SERVICES[@]}"; do
    [[ -n "${READY[$svc]:-}" ]] && continue
    p="${PORT_OF[$svc]}"
    body="$(probe "$p" /ready)"
    kind='ready'
    if [[ -z "$body" ]]; then
      body="$(probe "$p" /health)"
      kind='health'
    fi
    # Whitespace-insensitive: never couple a gate to a serializer's spacing.
    norm="${body//[[:space:]]/}"
    if [[ -n "$norm" && "$norm" == *"\"service\":\"$svc\""* ]]; then
      READY[$svc]="$kind"
    elif [[ -n "$norm" ]]; then
      READY[$svc]="WRONG:$body"
    else
      all_ready=0
    fi
  done
  [[ $all_ready -eq 1 ]] && break
  if ! kill -0 "-$BOOT_PGID" 2>/dev/null && ! kill -0 "$BOOT_PGID" 2>/dev/null; then
    boot_died=1
    break
  fi
  (( $(date +%s) >= deadline )) && break
  sleep 2
done

for svc in "${SERVICES[@]}"; do
  p="${PORT_OF[$svc]}"
  state="${READY[$svc]:-}"
  if [[ "$state" == 'ready' || "$state" == 'health' ]]; then
    note_pass "$svc — $state on :$p"
  elif [[ "$state" == WRONG:* ]]; then
    note_fail "$svc — :$p answered as someone else: ${state#WRONG:}"
  else
    note_fail "$svc — never answered /ready or /health on :$p"
  fi
done

[[ $boot_died -eq 1 ]] && note_fail 'scripts/dev.sh exited before every service was ready'

# ── Summary ───────────────────────────────────────────────────────────
printf '\n%s─────────────────────────────────────────────%s\n' "$BOLD" "$NC"
printf 'Checks: %s%d passed%s, ' "$GREEN" "$pass" "$NC"
if [[ $fail -eq 0 ]]; then
  printf '%s%d failed%s\n' "$GREEN" "$fail" "$NC"
  printf '%s%sDEV BOOT GREEN — all %d services start from %s through `pnpm dev` ✓%s\n' \
    "$GREEN" "$BOLD" "${#SERVICES[@]}" "$ENV_FILE" "$NC"
  exit 0
fi
printf '%s%d failed%s\n' "$RED" "$fail" "$NC"
printf 'Failed:\n'
for f in "${FAILED[@]}"; do printf '  %s✗ %s%s\n' "$RED" "$f" "$NC"; done

# Fail loud WITH EVIDENCE, inline in the job output. Pointing at a discarded
# tmpdir is why the first red run of this proof could not be diagnosed.
printf '\n%s── scripts/dev.sh output (last 200 lines of %s) ──%s\n' \
  "$BOLD" "${BOOT_LOG#"$REPO_ROOT"/}" "$NC"
tail -n 200 "$BOOT_LOG" 2>/dev/null | sed 's/^/    /'
printf '\n%sfull log retained at %s%s\n' "$BOLD" "${BOOT_LOG#"$REPO_ROOT"/}" "$NC"
exit 1
