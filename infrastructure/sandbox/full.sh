#!/usr/bin/env bash
# pnpm sandbox:full — the WHOLE system, every unit, production-shaped, on one machine.
#
#   pnpm sandbox:full                     boot everything (idempotent: what is already up is reused)
#   pnpm sandbox:full --real-sms          the owner's real Twilio, guarded to TWILIO_TO (see below)
#   pnpm sandbox:full --journeys          also play every citizen journey through the real edge
#   pnpm sandbox:full --kafka-ui          also a Kafka UI on the sandbox broker (:4994, +256 MB)
#   pnpm sandbox:full --rebuild           rebuild the services and the three app bundles
#   pnpm sandbox:full --status            what is running
#   pnpm sandbox:full --down              stop what this script started (data kept)
#
# What comes up, in order:
#   1. tier1 infrastructure     Postgres (5432), RIB and HEC mocks
#   2. the sandbox (ADR-047)    own Kafka (:4992), G2G simulators (:4900: NIDA, NESA, Irembo, Twilio),
#                               the 12 services under NODE_ENV=production + USRP_ENVIRONMENT=sandbox with
#                               freshly minted secrets, the document door with its own MinIO (:4993) and
#                               ClamAV (:4995), the edge (:4921)
#   3. data                     the six real campaigns (policy v2 as printed) and the clearance matrix;
#                               synthetic personas exported to .sandbox/personas
#   4. the three apps           PRODUCTION bundles (vite build), each served on its own origin with /edge
#                               proxied to the edge, as one deployed domain would be:
#                               applicant portal :4930, officer console :4931, Field Station :4932
#
# The frontend checkout: USRP_UI_DIR, else ../e-recruitment-ui next to this repository (or next to the
# worktrees/ folder). Real SMS: --real-sms reads ~/.config/usrp/twilio.env (chmod 600, outside every git
# work tree; TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, TWILIO_TO) and the owner's private persona
# from ~/.config/usrp/persona when present. Every destination except TWILIO_TO is refused before Twilio is
# called, and --journeys is refused with --real-sms (the synthetic population has real-looking numbers).
#
# It stops nothing it did not start: processes are recorded in .sandbox/pids and stopped only while they
# still run from this repository or the frontend checkout.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
STATE="$REPO/.sandbox"; LOGS="$STATE/logs"; PIDS="$STATE/pids"; WEB="$STATE/web"
export SANDBOX_DB="${SANDBOX_DB:-usrp_sandbox}" SANDBOX_FORENSICS=1 REHEARSAL_COEXIST=1
EDGE="http://localhost:4921"
APPS=("applicant-portal:4930" "officer-console:4931" "field-station:4932")

REAL_SMS=0; JOURNEYS=0; KAFKA_UI=0; REBUILD=0; ACTION=up
for arg in "$@"; do
  case "$arg" in
    --real-sms) REAL_SMS=1 ;; --journeys) JOURNEYS=1 ;; --kafka-ui) KAFKA_UI=1 ;; --rebuild) REBUILD=1 ;;
    --down) ACTION=down ;; --status) ACTION=status ;;
    *) echo "✗ unknown option $arg (see the header of $0)" >&2; exit 2 ;;
  esac
done

say() { printf '\033[0;36m▶ %s\033[0m\n' "$*"; }
die() { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" 2>/dev/null; }
busy() { ss -H -ltn "sport = :$1" | grep -q .; }

UI="${USRP_UI_DIR:-}"
if [ -z "$UI" ]; then
  for candidate in "$REPO/../e-recruitment-ui" "$REPO/../../e-recruitment-ui"; do
    [ -d "$candidate/apps/applicant-portal" ] && UI="$(cd "$candidate" && pwd)" && break
  done
fi

# A recorded PID is stopped only while it still runs from one of our checkouts (a reboot reuses PIDs).
stop_recorded() { # name
  local file="$PIDS/$1" pid
  [ -f "$file" ] || return 0
  pid="$(cat "$file")"
  # The command line may be relative (vite, pnpm): the working directory decides, the command line otherwise.
  if { readlink "/proc/$pid/cwd" 2>/dev/null; ps -o command= -p "$pid" 2>/dev/null; } | grep -qF -e "$REPO" -e "${UI:-/nonexistent}"; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  fi
  rm -f "$file"
}

status() {
  printf '\n%-28s %s\n' "UNIT" "STATE"
  local p
  for p in "g2g simulators:4900" "identity:4901" "eligibility:4902" "biometric:4903" "document-forensics:4904" \
           "background-vetting:4905" "application:4906" "scheduling:4907" "notification:4908" "field-sync:4909" \
           "audit:4910" "iam:4911" "edge gateway:4921"; do
    local path=/ready; [ "${p##*:}" = 4900 ] && path=/health
    printf '%-28s %s\n' "${p%%:*} :${p##*:}" "$([ "$(code "http://localhost:${p##*:}$path")" = 200 ] && echo "✓ ready" || echo "✗ down")"
  done
  for a in "${APPS[@]}"; do
    printf '%-28s %s\n' "${a%%:*} :${a##*:}" "$([ "$(code "http://localhost:${a##*:}/")" = 200 ] && echo "✓ production bundle" || echo "✗ down")"
  done
  docker ps --format '{{.Names}}\t{{.Status}}' | grep -E '^usrp-' | while IFS=$'\t' read -r n s; do printf '%-28s %s\n' "$n" "$s"; done
  printf '%-28s %s\n' "SMS" "$(grep -o 'SMS: [^·]*' "$LOGS/sandbox-up.out" 2>/dev/null | tail -1)"
  printf '%-28s %s\n' "memory available" "$(free -h | awk '/^Mem/{print $7}') of $(free -h | awk '/^Mem/{print $2}')"
}

if [ "$ACTION" = status ]; then status; exit 0; fi

if [ "$ACTION" = down ]; then
  for a in "${APPS[@]}"; do stop_recorded "web-${a%%:*}"; done
  docker rm -f usrp-sandbox-kafka-ui >/dev/null 2>&1 || true
  pnpm -s sandbox:down
  echo "✓ the apps, the services and the sandbox broker are stopped (database and state kept; tier1 Postgres left running)"
  exit 0
fi

# ── preflight ─────────────────────────────────────────────────────
[ -n "$UI" ] || die "the frontend checkout was not found; set USRP_UI_DIR=/path/to/e-recruitment-ui"
command -v docker >/dev/null || die "docker is required"
docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"
if [ "$REAL_SMS" = 1 ]; then
  [ "$JOURNEYS" = 0 ] || die "--journeys with --real-sms would text the synthetic population; run them on the emulator"
  export SANDBOX_SMS=twilio SANDBOX_TWILIO_ENV_FILE="${SANDBOX_TWILIO_ENV_FILE:-$HOME/.config/usrp/twilio.env}"
  [ -f "$SANDBOX_TWILIO_ENV_FILE" ] || die "--real-sms needs $SANDBOX_TWILIO_ENV_FILE"
  if [ -z "${SANDBOX_PRIVATE_PERSONA_DIR:-}" ] && [ -d "$HOME/.config/usrp/persona" ]; then export SANDBOX_PRIVATE_PERSONA_DIR="$HOME/.config/usrp/persona"; fi
fi
mkdir -p "$LOGS" "$PIDS" "$WEB"; chmod 700 "$STATE"
avail_mb="$(free -m | awk '/^Mem/{print $7}')"
[ "$avail_mb" -ge 2500 ] || printf '\033[0;33m! only %s MB available: the full system wants ~4 GB (ClamAV alone ~1.3 GB). Close heavy apps for honest timings.\033[0m\n' "$avail_mb"

# ── 1. tier1 infrastructure ───────────────────────────────────────
say "tier1: Postgres, RIB and HEC mocks"
docker compose -f infrastructure/docker/docker-compose.tier1.yml up -d --wait postgres rib-mock hec-mock > "$LOGS/full-tier1.out" 2>&1 \
  || die "tier1 did not come up; see $LOGS/full-tier1.out"

# ── 2. build ──────────────────────────────────────────────────────
if [ ! -d node_modules ]; then say "installing backend dependencies"; pnpm install --frozen-lockfile --prefer-offline > "$LOGS/full-install.out" 2>&1 || die "pnpm install failed"; fi
if [ "$REBUILD" = 1 ] || ! node scripts/check-workspace-build.mjs > /dev/null 2>&1; then
  say "building the services"
  pnpm exec turbo run build > "$LOGS/full-build.out" 2>&1 || die "the build failed; see $LOGS/full-build.out"
fi

# ── 3. the sandbox and its data ───────────────────────────────────
if [ "$(code "$EDGE/edge/v1/session")" = 000 ]; then
  # A reboot leaves PID files behind; the launcher only stops what still runs from here.
  pnpm -s sandbox:down > /dev/null 2>&1 || true
fi
say "sandbox: broker, simulators, 12 services, document door, six campaigns (database $SANDBOX_DB)"
bash infrastructure/sandbox/up.sh > "$LOGS/full-up.out" 2>&1 || { tail -5 "$LOGS/full-up.out" >&2; die "sandbox:up failed; see $LOGS/full-up.out"; }
[ "$(code http://localhost:4904/ready)" = 200 ] \
  || printf '\033[0;33m! the running sandbox was started without the document door; run --down, then again\033[0m\n'
say "clearance matrix and personas"
USRP_SANDBOX=1 USRP_SANDBOX_STATE="$STATE" pnpm -s rehearse --sandbox clearance-matrix > "$LOGS/full-stage-clearance.out" 2>&1 || true
for scenario in rdf-2026 rnp-basic-2025 rcs-junior-2025 rcs-officer-2026-4y clearance-matrix; do
  USRP_SANDBOX=1 USRP_SANDBOX_STATE="$STATE" pnpm -s rehearse --sandbox "$scenario" --journey --export-personas > "$LOGS/full-personas-$scenario.out" 2>&1 \
    || printf '\033[0;33m! could not export the %s personas; see %s\033[0m\n' "$scenario" "$LOGS/full-personas-$scenario.out"
done

# ── 4. the three apps as production bundles ───────────────────────
if [ ! -d "$UI/node_modules" ]; then say "installing frontend dependencies"; (cd "$UI" && pnpm install --frozen-lockfile --prefer-offline) > "$LOGS/full-ui-install.out" 2>&1 || die "frontend install failed"; fi
anchor="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).QR_INVITATION_PUBLIC_KEY_B64 ?? '')" "$STATE/secrets.json" 2>/dev/null)"
ui_rev="$(git -C "$UI" rev-parse HEAD)$(git -C "$UI" status --porcelain | sha1sum | cut -c1-8)"
for a in "${APPS[@]}"; do
  app="${a%%:*}"; port="${a##*:}"; out="$WEB/$app"
  stamp="$ui_rev:$port:$(printf '%s' "$anchor" | sha1sum | cut -c1-8)"
  if [ "$REBUILD" = 1 ] || [ "$(cat "$out/.usrp-build" 2>/dev/null)" != "$stamp" ]; then
    say "building $app (production bundle, sandbox banner on)"
    ( cd "$UI/apps/$app" && VITE_EDGE_URL="http://localhost:$port" VITE_USRP_SANDBOX=1 VITE_FIELD_STATION_URL="http://localhost:4932" \
        VITE_SLOT_TRUST_ANCHOR_B64="$anchor" pnpm exec vite build --outDir "$out" --emptyOutDir ) > "$LOGS/full-build-$app.out" 2>&1 \
      || die "the $app build failed; see $LOGS/full-build-$app.out"
    echo "$stamp" > "$out/.usrp-build"
  fi
  if [ "$(code "http://localhost:$port/")" = 200 ] && [ -f "$PIDS/web-$app" ]; then continue; fi
  busy "$port" && die ":$port is busy with a server this script did not start; stop it first"
  # exec setsid: the recorded PID IS the server and its session leader, and nothing keeps this script's stdout open.
  ( cd "$UI/apps/$app" || exit 1; VITE_EDGE_URL="$EDGE" exec setsid pnpm exec vite preview --outDir "$out" --port "$port" --strictPort ) \
    > "$LOGS/full-web-$app.out" 2>&1 < /dev/null &
  echo $! > "$PIDS/web-$app"
done
for a in "${APPS[@]}"; do
  for _ in $(seq 1 30); do [ "$(code "http://localhost:${a##*:}/")" = 200 ] && break; sleep 1; done
done

# ── 5. optional ───────────────────────────────────────────────────
if [ "$KAFKA_UI" = 1 ] && ! docker ps --format '{{.Names}}' | grep -qx usrp-sandbox-kafka-ui; then
  say "Kafka UI on :4994"
  docker rm -f usrp-sandbox-kafka-ui >/dev/null 2>&1 || true
  docker run -d --name usrp-sandbox-kafka-ui --network host -m 256m -e SERVER_PORT=4994 -e SERVER_ADDRESS=127.0.0.1 \
    -e KAFKA_CLUSTERS_0_NAME=usrp-sandbox -e KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS=localhost:4992 provectuslabs/kafka-ui:latest > /dev/null \
    || printf '\033[0;33m! Kafka UI did not start\033[0m\n'
fi
if [ "$JOURNEYS" = 1 ]; then
  say "playing every sandbox journey through the edge"
  bash infrastructure/sandbox/journeys.sh 2>&1 | tee "$LOGS/full-journeys.out" | grep -E 'PASSED|FAILED|✗' || true
fi

status
cat <<EOF

✓ sandbox:full is up
  applicant portal   http://localhost:4930   citizens: synthetic personas in .sandbox/personas (OTP: .sandbox/sms/inbox.jsonl$( [ "$REAL_SMS" = 1 ] && echo '; REAL SMS to TWILIO_TO only'))
  officer console    http://localhost:4931   rdf.admin / rnp.admin / rcs.admin (second admin: *.admin2), password RehearsalAdmin#2026
                                             station staff reh.<agency>.gate.*, reh.<agency>.reviewer, reh.<agency>.supervisor: RehearsalStaff#2026
  field station      http://localhost:4932
  edge               $EDGE     simulators :4900 (behaviour switch: header x-usrp-sandbox-behaviour)
  logs               $LOGS     guide: docs/sandbox/README.md
  stop               pnpm sandbox:full --down
EOF
