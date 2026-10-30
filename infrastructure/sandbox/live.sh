#!/usr/bin/env bash
# pnpm sandbox:live — the browser journeys across the three apps, against `pnpm sandbox:up` (S12c, kit item D).
#
#   USRP_UI_DIR=/path/to/e-recruitment-ui pnpm sandbox:live
#
# Stages the clearance matrix, exports the synthetic personas (to .sandbox/personas, git-ignored), serves the
# applicant portal, officer console and field station as SANDBOX builds of the frontend (dev servers on
# 4930, 4931 and 4932, proxying the sandbox edge on 4921) and runs the opt-in Playwright specs
# (apps/applicant-portal/e2e/live-sandbox.spec.ts, apps/officer-console/e2e/live-sandbox.spec.ts).
# The servers are started detached and stopped by process group when the run ends. Nothing it starts
# outlives it, and it never touches processes it did not start.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
UI="${USRP_UI_DIR:?set USRP_UI_DIR to the frontend checkout}"
export SANDBOX_DB="${SANDBOX_DB:-usrp_sandbox}" REHEARSAL_COEXIST=1 USRP_SANDBOX=1 USRP_SANDBOX_STATE="$REPO/.sandbox"
EDGE="http://localhost:4921"
LOGS="$REPO/.sandbox/logs"; mkdir -p "$LOGS"

[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$EDGE/edge/v1/session")" != 000 ] || { echo "✗ no sandbox answers on :4921; run pnpm sandbox:up first" >&2; exit 1; }
for port in 4930 4931 4932; do
  if ss -H -ltn "sport = :$port" | grep -q .; then echo "✗ :$port is busy (someone else's server?); not starting over it" >&2; exit 1; fi
done

echo "▶ staging and exporting personas"
for scenario in rdf-2026 clearance-matrix; do
  pnpm --silent rehearse --sandbox "$scenario" > "$LOGS/live-stage-$scenario.out" 2>&1 || true
  pnpm --silent rehearse --sandbox "$scenario" --journey --export-personas > "$LOGS/live-export-$scenario.out" 2>&1 || { echo "✗ could not export $scenario personas" >&2; exit 1; }
done

pids=()
start() { # app port
  ( cd "$UI/apps/$1" && VITE_EDGE_URL="$EDGE" VITE_USRP_SANDBOX=1 setsid pnpm exec vite --port "$2" --strictPort > "$LOGS/live-$1.out" 2>&1 & echo $! > "$LOGS/live-$1.pid" )
  pids+=("$(cat "$LOGS/live-$1.pid")")
}
stop() {
  for pid in "${pids[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; done
  # Whatever still listens on our three ports AND runs from the frontend checkout we started it in is ours: stop its process group.
  for port in 4930 4931 4932; do
    for p in $(ss -H -ltnp "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2); do
      case "$(readlink "/proc/$p/cwd" 2>/dev/null)" in "$UI"/*) kill -TERM -- "-$(ps -o pgid= -p "$p" | tr -d ' ')" 2>/dev/null || true;; esac
    done
  done
}
trap stop EXIT

start applicant-portal 4930; start officer-console 4931; start field-station 4932
for port in 4930 4931 4932; do
  for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$port/")" = 200 ] && break; sleep 2; done
done

echo "▶ warming the dev servers"
node "$REPO/infrastructure/sandbox/warm.mjs" "$UI" http://localhost:4930 http://localhost:4931 http://localhost:4932 || { echo "✗ a dev server did not come up" >&2; exit 1; }

rc=0
export USRP_PORTAL_URL=http://localhost:4930 USRP_OFFICER_URL=http://localhost:4931 USRP_FIELD_URL=http://localhost:4932
echo "▶ applicant portal (and the field-station gate)"
( cd "$UI/apps/applicant-portal" && pnpm exec playwright test -c playwright.sandbox.config.ts ) || rc=1
echo "▶ officer console"
( cd "$UI/apps/officer-console" && pnpm exec playwright test -c playwright.sandbox.config.ts ) || rc=1
[ "$rc" = 0 ] && echo "ALL LIVE SANDBOX JOURNEYS PASSED" || echo "LIVE SANDBOX JOURNEYS FAILED"
exit "$rc"
