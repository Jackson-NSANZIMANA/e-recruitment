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
# ── AND A PROOF MUST BE DIAGNOSABLE, NOT MERELY CORRECT ──
#
# This proof was RIGHT about biometric-service and useless about WHY, twice in
# one evening. Two causes, both fixed here:
#
#   • IT PRINTED A SHARED TAIL. `tail -n 200` of one log holding eleven
#     interleaved services means the noisiest services win the window. Ten
#     healthy services probed for 600s filled it with their own /ready
#     responses and pushed the hanging service's startup output out
#     entirely. Evidence is now selected PER SERVICE by turbo's `@usrp/<pkg>:`
#     prefix, so the failing service cannot be shouted over.
#
#   • IT WAITED OUT THE DEADLINE ON A DEAD SERVICE. The `dev` task is
#     `tsx watch`, which SURVIVES its child exiting — that is what watch mode
#     is for. So process.exit(1) inside a service does not end the process
#     group, `kill -0` keeps reporting it alive, and this loop polls a closed
#     socket for the remaining ten minutes. Every main() in this repo logs
#     `startup_failed` before exiting, so that marker is watched directly.
#
# It still boots through `pnpm dev`. Switching CI to the non-watch `start:dev`
# task would make crashes end the process group, and would also stop
# exercising turbo.json's `dev` allowlist — the one surface nothing else in
# the repo executes and the direct cause of two un-bootable-main incidents.
# Fail-fast is worth having; it is not worth blinding the proof to get it.
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
# four G2G mocks and ClamAV are already resident. 90s was optimistic, and
# 180s still wasn't enough (job failed on `Run all proofs` at ~7m40s).
# CI now pins this explicitly to 600s (see ci-backend.yml); 600s is the
# default here too, so a bare local run under load is covered as well.
#
# NOTE this is the ceiling for a SLOW boot, not the time a BROKEN one costs.
# A service that dies during startup is detected the moment it says so — see
# FATAL_STARTUP_PATTERN.
BOOT_TIMEOUT_S="${BOOT_TIMEOUT_S:-600}"
# Repo-relative ON PURPOSE. The first version wrote to `mktemp -d` and told the
# reader "logs kept in $LOG_DIR" — a directory the CI runner then discarded,
# which is exactly why the first red run of this proof was undiagnosable from
# the job output. Covered by the existing `*.log` ignore rule.
LOG_DIR="${USRP_BOOT_LOG_DIR:-$REPO_ROOT/.boot-logs}"
BOOT_LOG="$LOG_DIR/dev-boot.log"
INHERIT_ENV="${USRP_BOOT_INHERIT_ENV:-0}"

# Every service's main() ends with a .catch() that logs this and exits. It is
# therefore the one marker that means "this service is not coming up", for all
# eleven, regardless of cause — bad config, invalid key, unreachable broker.
FATAL_STARTUP_PATTERN='startup_failed'
# How many of a service's OWN lines to show when it fails. Generous: these are
# one service's lines, not eleven services' lines, so there is no flood to cap.
EVIDENCE_LINES="${USRP_BOOT_EVIDENCE_LINES:-80}"

GREEN=$'\033[0;32m'
RED=$'\033[0;31m'
CYAN=$'\033[1;36m'
BOLD=$'\033[1m'
NC=$'\033[0m'

ok()  { printf '%s\u2713 PASS — %s%s\n' "$GREEN" "$*" "$NC"; }
bad() { printf '%s\u2717 FAIL — %s%s\n' "$RED" "$*" "$NC"; }
log() { printf '%s\u2550\u2550 %s%s\n' "$CYAN" "$*" "$NC"; }

pass=0
fail=0
declare -a FAILED=()
note_pass() { ok "$1"; pass=$((pass + 1)); }
note_fail() { bad "$1"; fail=$((fail + 1)); FAILED+=("$1"); }

[[ -f "$ENV_FILE" ]] || { bad "$ENV_FILE not found"; exit 1; }
command -v curl >/dev/null 2>&1 || { bad 'curl is required'; exit 1; }

mkdir -p "$LOG_DIR"
: >"$BOOT_LOG"

# ── Service discovery ──────────────────────────────────────
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

# Turbo prefixes every line with '<package-name>:<task>: ' under --ui=stream,
# and the package name is always @usrp/<directory>. That prefix is the ONLY
# thing that attributes a line in the shared log to a service, so selecting on
# it is what makes per-service evidence possible.
turbo_prefix_for() {
  printf '@usrp/%s:dev:' "$1"
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

# ── 1. Static: the template assigns every service its OWN port ─────
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
  printf '\n%s\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500%s\n' "$BOLD" "$NC"
  printf '%s%d failed%s — port contract is broken; not booting services.\n' "$RED" "$fail" "$NC"
  exit 1
fi

# ── 3. Boot through the REAL entrypoint, in a SANITIZED environment ────
# `pnpm dev` is `bash scripts/dev.sh`, which sources the env file and execs
# `turbo run dev --parallel`. We invoke exactly that, so the loading boundary
# AND Turbo's strict-mode allowlist are both under test. --ui=stream because
# turbo.json sets "ui": "tui", which is useless in a captured CI log — and
# because stream mode is what prefixes each line with its package name, which
# is what per-service evidence below depends on.
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
fatal_startup=0

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

  # FAIL FAST on a service that has ALREADY given up. `tsx watch` outlives its
  # child by design, so process.exit(1) in a service does NOT end the process
  # group and the liveness check below stays true — which is how a crash that
  # is known in two seconds used to cost the entire ten-minute deadline.
  if grep -q "$FATAL_STARTUP_PATTERN" "$BOOT_LOG" 2>/dev/null; then
    fatal_startup=1
    log 'a service reported startup_failed — not waiting out the deadline'
    break
  fi

  if ! kill -0 "-$BOOT_PGID" 2>/dev/null && ! kill -0 "$BOOT_PGID" 2>/dev/null; then
    boot_died=1
    break
  fi
  (( $(date +%s) >= deadline )) && break
  sleep 2
done

declare -a FAILED_SERVICES=()
for svc in "${SERVICES[@]}"; do
  p="${PORT_OF[$svc]}"
  state="${READY[$svc]:-}"
  if [[ "$state" == 'ready' || "$state" == 'health' ]]; then
    note_pass "$svc — $state on :$p"
  elif [[ "$state" == WRONG:* ]]; then
    note_fail "$svc — :$p answered as someone else: ${state#WRONG:}"
    FAILED_SERVICES+=("$svc")
  else
    note_fail "$svc — never answered /ready or /health on :$p"
    FAILED_SERVICES+=("$svc")
  fi
done

[[ $boot_died -eq 1 ]] && note_fail 'scripts/dev.sh exited before every service was ready'

# ── Evidence ────────────────────────────────────────────────────
# ONE SERVICE'S LINES AT A TIME. A shared tail is what made the last two red
# runs undiagnosable: the services that WORKED out-logged the one that did not.
dump_service_log() {
  local svc="$1" prefix lines
  prefix="$(turbo_prefix_for "$svc")"
  lines="$(grep -F "$prefix" "$BOOT_LOG" 2>/dev/null | tail -n "$EVIDENCE_LINES")"
  printf '\n%s\u2500\u2500 %s — its own last %s lines ─\u2500%s\n' "$BOLD" "$svc" "$EVIDENCE_LINES" "$NC"
  if [[ -n "$lines" ]]; then
    printf '%s\n' "$lines" | sed 's/^/    /'
  else
    # Not a formatting edge case — a real and specific diagnosis. No output at
    # all under this package's prefix means the process never got far enough to
    # print, or turbo never ran its dev task. The unprefixed section below is
    # where that failure lives.
    printf '    (no output under %s at all — the process printed nothing, or\n' "$prefix"
    printf '     turbo never started its dev task. See the harness lines below.)\n'
  fi
}

# ── Summary ──────────────────────────────────────────────────
printf '\n%s\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500%s\n' "$BOLD" "$NC"
printf 'Checks: %s%d passed%s, ' "$GREEN" "$pass" "$NC"
if [[ $fail -eq 0 ]]; then
  printf '%s%d failed%s\n' "$GREEN" "$fail" "$NC"
  printf '%s%sDEV BOOT GREEN — all %d services start from %s through `pnpm dev` \u2713%s\n' \
    "$GREEN" "$BOLD" "${#SERVICES[@]}" "$ENV_FILE" "$NC"
  exit 0
fi
printf '%s%d failed%s\n' "$RED" "$fail" "$NC"
printf 'Failed:\n'
for f in "${FAILED[@]}"; do printf '  %s\u2717 %s%s\n' "$RED" "$f" "$NC"; done

# Fail loud WITH EVIDENCE, inline in the job output, ATTRIBUTED. Pointing at a
# discarded tmpdir is why the first red run could not be diagnosed; printing a
# shared tail is why the next two could not be either.
if [[ $fatal_startup -eq 1 ]]; then
  printf '\n%s\u2500\u2500 startup_failed reported by ─\u2500%s\n' "$BOLD" "$NC"
  grep "$FATAL_STARTUP_PATTERN" "$BOOT_LOG" 2>/dev/null | tail -n 20 | sed 's/^/    /'
fi

for svc in "${FAILED_SERVICES[@]}"; do
  dump_service_log "$svc"
done

# Lines with NO package prefix are turbo's own and the env boundary's: a
# strict-mode drop, a missing template variable, a pnpm resolution failure. A
# service that never started at all leaves its ONLY trace here.
printf '\n%s\u2500\u2500 harness / turbo output (unattributed lines) ─\u2500%s\n' "$BOLD" "$NC"
grep -v '^@usrp/' "$BOOT_LOG" 2>/dev/null | tail -n 40 | sed 's/^/    /'

printf '\n%sfull log retained at %s%s\n' "$BOLD" "${BOOT_LOG#"$REPO_ROOT"/}" "$NC"
exit 1
