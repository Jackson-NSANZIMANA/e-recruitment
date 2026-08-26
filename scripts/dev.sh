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

# Turbo percentage concurrency is relative to the runner's CPU count. On a
# small CI runner, `--concurrency=100%` can therefore be only 2 or 4 tasks;
# persistent `tsx watch` tasks occupy those slots forever and the remaining
# services are never spawned. That failure is silent: no package prefix,
# no startup marker, no socket. Use an explicit numeric ceiling instead.
#
# There are currently 19 packages in scope and 11 persistent service `dev`
# tasks. `100` is intentionally above the package count so a newly-added
# service cannot be starved by the scheduler. Turbo still filters execution
# through each package's actual `dev` script; this does not create processes
# for packages without one.
#
# `--parallel` is deprecated in the installed Turbo version. An explicit
# concurrency value provides the same scheduling behaviour without the
# deprecated flag.
exec pnpm exec turbo run dev --concurrency=100 "$@"

