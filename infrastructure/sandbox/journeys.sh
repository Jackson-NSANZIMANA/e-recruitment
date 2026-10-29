#!/usr/bin/env bash
# pnpm sandbox:journeys — play every sandbox journey through the real edge (S12c, kit item D, backend half).
# Needs a running `pnpm sandbox:up`. Prints one line per persona; exits non-zero on any failure.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
export SANDBOX_DB="${SANDBOX_DB:-usrp_sandbox}" REHEARSAL_COEXIST=1
# Scenarios with personas. rcs-officer-2026-1y and rnp-cadet-2025 have none: HEC holds no sandbox persona yet.
JOURNEYS=(rdf-2026 rnp-basic-2025 rcs-junior-2025 rcs-officer-2026-4y clearance-matrix)
failed=0
for scenario in "${JOURNEYS[@]}"; do
  echo "== $scenario"
  # Staging is idempotent; it also covers a journey scenario sandbox:up does not stage (clearance-matrix).
  pnpm --silent rehearse --sandbox "$scenario" > /dev/null 2>&1 || true
  out="$(pnpm --silent rehearse --sandbox "$scenario" --journey 2>&1)"
  printf '%s\n' "$out" | grep -E '^(✓|✗)|^SANDBOX|    ✗' || true
  printf '%s\n' "$out" | grep -q 'SANDBOX JOURNEY PASSED' || failed=1
done
[ "$failed" = 0 ] && echo "ALL SANDBOX JOURNEYS PASSED" || { echo "SANDBOX JOURNEYS FAILED"; exit 1; }
