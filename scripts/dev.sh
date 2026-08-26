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

# `dev` is persistent (`tsx watch`). Turbo's default concurrency is 10, but
# this workspace has 11 service dev tasks. The first ten watchers consume all
# slots forever and the eleventh is queued indefinitely, so it never prints,
# never binds its port, and the boot proof can only report a missing health
# endpoint. Start all persistent service tasks together. `100%` is dynamic:
# it remains correct when another service is added, unlike a hard-coded 11.
exec pnpm exec turbo run dev --parallel --concurrency=100% "$@"

