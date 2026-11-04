#!/usr/bin/env bash
# pnpm sandbox:up — the whole recruitment sandbox in one command (S12c, ADR-047/049).
#
#   pnpm sandbox:up               boot the sandbox (own database, own broker, 49xx), then stage
#                                 the six real campaigns from policy v2 (idempotent: safe to repeat)
#   SANDBOX_DB=usrp_sandbox_x pnpm sandbox:up     use another database name (shared machines)
#   pnpm sandbox:down             stop (keeps data)       pnpm sandbox:reset   stop + drop the sandbox database
#
# Isolation: the same rules as `pnpm sandbox` (own database on the shared Postgres server, own Kafka
# compose project `usrp-sandbox`, ports 4900-4921, state in .sandbox/). It never touches the dev
# stack, and refuses to start when the 49xx ports are busy with a sandbox that is not running its own
# edge (someone else's). It stops nothing it did not start.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
export SANDBOX_DB="${SANDBOX_DB:-usrp_sandbox}"
# All six campaigns stay open together (only earlier days retire).
export REHEARSAL_COEXIST=1
STATE="$REPO/.sandbox"
mkdir -p "$STATE/logs"
EDGE="http://localhost:4921"

# Campaign scenarios, in the order of the announcements document (§1–§5). Every one is staged from
# its printed facts; a scenario for an agency that already has an open campaign retires that one.
SCENARIOS=(rdf-2026 rnp-basic-2025 rnp-cadet-2025 rcs-junior-2025 rcs-officer-2026-1y rcs-officer-2026-4y)

say() { printf '▶ %s\n' "$*"; }

if [ ! -d "$REPO/node_modules" ]; then say "installing dependencies"; pnpm install --frozen-lockfile --prefer-offline; fi
if [ ! -f "$REPO/packages/shared-types/dist/index.js" ] || [ -n "${SANDBOX_REBUILD:-}" ]; then say "building"; pnpm exec turbo run build; fi

edge_up() { [ "$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$EDGE/edge/v1/session" 2>/dev/null)" != "000" ]; }

# A running sandbox is reused only when it is provably whole and serves the database asked for: its boot
# record (.sandbox/running.json, written once every unit answered) names SANDBOX_DB and the document door
# setting, every unit it started still answers /ready, and its broker container runs. Anything less (a boot
# interrupted half-way, another database, a dead broker) is refused rather than staged against.
reusable() {
  local why
  why="$(node -e '
    const [file, db, forensics] = process.argv.slice(1);
    let r; try { r = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch { console.log("it has no complete boot record (an interrupted or older boot)"); process.exit(1); }
    if (r.db !== db) { console.log(`it serves database ${r.db}, not ${db}`); process.exit(1); }
    if (String(r.forensics) !== String(forensics === "1")) { console.log(`it was started with SANDBOX_FORENSICS=${r.forensics ? 1 : 0}`); process.exit(1); }
    console.log([r.simulator + "/health", ...r.ports.map((p) => p + "/ready")].join(" "));' "$STATE/running.json" "$SANDBOX_DB" "${SANDBOX_FORENSICS:-}")" \
    || { echo "$why"; return 1; }
  local probe
  for probe in $why; do
    [ "$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://localhost:${probe%%/*}/${probe#*/}" 2>/dev/null)" = 200 ] \
      || { echo "its unit on :${probe%%/*} does not answer /${probe#*/}"; return 1; }
  done
  [ "$(docker inspect -f '{{.State.Running}}' usrp-sandbox-kafka 2>/dev/null)" = true ] || { echo "its broker (usrp-sandbox-kafka) is not running"; return 1; }
}

if edge_up; then
  if ! why="$(reusable)"; then
    echo "✗ a sandbox is answering on :4921, but $why. Stop it with \`pnpm sandbox:full --down\` (data is kept), then run this again." >&2
    exit 1
  fi
  say "a complete sandbox for database $SANDBOX_DB is already running — reusing it (nothing is restarted)"
else
  if ss -H -ltn 'sport = :4900' | grep -q .; then
    echo "✗ :4900 is busy but no sandbox edge answers on :4921: another sandbox is starting or half-stopped. Wait, or run its own pnpm sandbox:down." >&2
    exit 1
  fi
  # One-time work first, in the foreground and untimed: a first boot builds the MinIO image from source
  # (minutes on a slow machine), which must not count against the boot window below.
  pnpm --silent --filter @usrp/g2g-sandbox sandbox prepare || exit 1
  say "starting the sandbox (database $SANDBOX_DB)"
  setsid nohup pnpm sandbox > "$STATE/logs/sandbox-up.out" 2>&1 &
  launcher=$!
  for _ in $(seq 1 150); do
    if grep -q 'sandbox up ·' "$STATE/logs/sandbox-up.out" 2>/dev/null; then break; fi
    if grep -q '^✗' "$STATE/logs/sandbox-up.out" 2>/dev/null; then cat "$STATE/logs/sandbox-up.out" >&2; exit 1; fi
    sleep 2
  done
  if ! edge_up; then
    if kill -0 "$launcher" 2>/dev/null; then
      echo "✗ the sandbox did not come up in 5 minutes and is STILL starting (pid $launcher); see $STATE/logs/sandbox-up.out (tail -f it), then run this again" >&2
    else
      echo "✗ the sandbox did not come up in time; see $STATE/logs/sandbox-up.out" >&2
    fi
    exit 1
  fi
fi

for scenario in "${SCENARIOS[@]}"; do
  say "staging $scenario (policy v2 as printed)"
  pnpm --silent rehearse --sandbox "$scenario" > "$STATE/logs/stage-$scenario.out" 2>&1 \
    || { echo "✗ staging $scenario failed; see $STATE/logs/stage-$scenario.out" >&2; exit 1; }
  grep -q 'REHEARSAL STAGED' "$STATE/logs/stage-$scenario.out" || { echo "✗ $scenario was not staged; see $STATE/logs/stage-$scenario.out" >&2; exit 1; }
done

cat <<EOF

✓ sandbox:up complete
  edge            $EDGE   (simulators :4900, SMS inbox $STATE/sms/inbox.jsonl)
  guide           docs/sandbox/README.md   (URLs, staff handles, personas, behaviour switches)
  journeys        pnpm rehearse --sandbox <scenario> --journey
  stop            pnpm sandbox:down        reset  pnpm sandbox:reset
EOF
