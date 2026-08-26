#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# dev.sh — the ONE place the development environment is loaded.
#
# Two facts have to hold together, and only one of them is a turbo.json edit:
#
#   1. Turborepo does not read .env files, and neither does tsx. Something
#      has to put the values into the shell. That is this script.
#   2. Turbo 2.x runs in STRICT env mode by default, so a task's child
#      process only receives variables enumerated in that task's `env`
#      (or globalEnv / passThroughEnv). That is turbo.json.
#
# Deliberately ONE boundary. The alternative — `--env-file=../../.env` in
# all eleven service package.json files — hard-codes the repo layout eleven
# times, lets the dev environment drift per service, and trades tsx watch's
# restart semantics for nothing. `set -a; source` is the same idiom
# scripts/run-selfchecks.sh already uses for the gate.
#
# Usage:  pnpm dev
#         pnpm dev --filter=@usrp/identity-service
#         USRP_ENV_FILE=.env.local pnpm dev
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="${USRP_ENV_FILE:-.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  printf '\033[0;31m✗ %s not found.\033[0m\n' "$ENV_FILE" >&2
  printf '  Render one first:  \033[0;36mpnpm generate:env\033[0m\n' >&2
  exit 1
fi

# set -a exports every assignment the file makes, and nothing else.
set -a
# shellcheck disable=SC1090
source "./$ENV_FILE"
set +a

printf '\033[0;36m▶ loaded %s — starting services\033[0m\n' "$ENV_FILE"

# Every runnable service has a persistent `dev` task (`tsx watch`). Turbo's
# default concurrency can be smaller than that set, which leaves the excess
# tasks queued forever: no process, no output, no socket, only a misleading
# health-check timeout. Count the same src/main.ts contract used by
# verify-dev-boot.sh and make every runnable service schedulable immediately.
SERVICE_TASK_COUNT=0
for dir in services/*/; do
  if [[ -f "${dir}src/main.ts" ]]; then
    SERVICE_TASK_COUNT=$((SERVICE_TASK_COUNT + 1))
  fi
done

if (( SERVICE_TASK_COUNT == 0 )); then
  printf '\033[0;31m✗ no runnable services found under services/*/src/main.ts.\033[0m\n' >&2
  exit 1
fi

# Turbo requires concurrency to be STRICTLY GREATER than the number of
# persistent tasks. Equal values are rejected before any task starts, which
# turns a valid service set into an all-or-nothing boot failure. Keep one slot
# of headroom while deriving the count from the repository itself.
SERVICE_TASK_CONCURRENCY=$((SERVICE_TASK_COUNT + 1))
if (( SERVICE_TASK_CONCURRENCY <= SERVICE_TASK_COUNT )); then
  printf '\033[0;31m✗ invalid Turbo concurrency: %s for %s persistent services.\033[0m\n' \
    "$SERVICE_TASK_CONCURRENCY" "$SERVICE_TASK_COUNT" >&2
  exit 1
fi

# Use a numeric count, not `100%`: Turbo percentage concurrency is relative to
# available CPU capacity, so 100% on a small CI runner may still schedule only
# two or four persistent tasks. Use the derived count plus Turbo's required
# headroom instead. `--parallel` is deprecated in current Turbo and is
# unnecessary when the concurrency is explicit.
exec pnpm exec turbo run dev --concurrency="$SERVICE_TASK_CONCURRENCY" "$@"

