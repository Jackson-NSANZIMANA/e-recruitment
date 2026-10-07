#!/usr/bin/env bash
#
# count-lint.sh — the single, authoritative lint-debt measuring stick.
#
# Prints the total number of ESLint ERRORS across every workspace package to
# stdout (one integer, nothing else). Writes the raw lint log to the path given
# by $LINT_LOG (default: a temp file) so callers can grep it for rule detail.
#
# WHY THIS SCRIPT EXISTS — four ways the naive count is wrong, all fixed here:
#
#   1. MISSING LINT SCRIPT. packages/shared-database had no `lint` script at
#      all, so `pnpm -r run lint` skipped it and 7 errors were invisible.
#      Fixed in its package.json; this script's preflight re-asserts that every
#      package still has one, so the hole cannot silently reopen.
#   2. UNQUOTED GLOB. `eslint src/**/*.ts` unquoted is expanded by sh, whose
#      `**` collapses to a single level — it undercounted 126 as 119. Every
#      package script now quotes it ('src/**/*.ts') so ESLint does the globbing.
#   3. FAIL-FAST. `pnpm lint` (via turbo) stops at the first failing package and
#      hides the rest. We use `pnpm -r --no-bail` so every package reports.
#   4. SINGULAR "problem". ESLint prints "✖ 1 problem (1 error, 0 warnings)" —
#      singular — when a package has exactly one. A `[0-9]+ problems` regex
#      drops those packages entirely; that is why the handover's documented 126
#      measured as 124 (audit-service and biometric-service have 1 each).
#      The regex below is `problems?` / `errors?`.
#
# AND THE PRECONDITION: ALWAYS BUILD FIRST. Linting an unbuilt tree reports
# ~1200 phantom errors, because the type-aware rules cannot resolve workspace
# imports without the emitted dist/. Pass --build (or set LINT_BUILD=1) to have
# this script run `pnpm build` for you.
#
# Usage:
#   scripts/count-lint.sh                  # assumes the tree is already built
#   scripts/count-lint.sh --build          # build first, then count
#   LINT_LOG=/tmp/lint.log scripts/count-lint.sh --build
#
set -euo pipefail

cd "$(dirname "$0")/.."

LINT_LOG="${LINT_LOG:-$(mktemp -t lint-XXXXXX.log)}"
export LINT_LOG

if [[ "${1:-}" == "--build" || "${LINT_BUILD:-0}" == "1" ]]; then
  pnpm build >"${LINT_LOG}.build" 2>&1 || {
    echo "count-lint: BUILD FAILED — a count on an unbuilt tree is meaningless." >&2
    tail -30 "${LINT_LOG}.build" >&2
    exit 2
  }
fi

# Preflight (guards defect 1 and 2): every workspace package must have a lint
# script, and it must quote its glob. A package that loses either one stops
# being measured, which looks like debt going down.
missing="$(node -e '
const fs = require("fs"), path = require("path");
const bad = [];
for (const dir of ["packages", "services"]) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name, "package.json");
    if (!fs.existsSync(p)) continue;
    const lint = (JSON.parse(fs.readFileSync(p, "utf8")).scripts || {}).lint;
    if (!lint) bad.push(p + " :: NO lint script");
    else if (!/'"'"'src\/\*\*\/\*\.ts'"'"'/.test(lint)) bad.push(p + " :: glob not quoted: " + lint);
  }
}
process.stdout.write(bad.join("\n"));
')"
if [[ -n "$missing" ]]; then
  echo "count-lint: lint machinery is broken — these packages would not be measured:" >&2
  echo "$missing" >&2
  exit 2
fi

# --no-bail: do not let the first failing package hide the others.
pnpm -r --no-bail run lint >"$LINT_LOG" 2>&1 || true

# `problems?` / `errors?` — see defect 4 above.
#
# The `|| true` is load-bearing: with zero errors grep matches nothing and
# exits 1, and under `set -o pipefail` that would make THIS SCRIPT FAIL ON A
# CLEAN TREE — i.e. the gate would go red exactly when the code is perfect.
# Found by running it at 0. The count is printed by awk either way.
{ grep -oE '[0-9]+ problems? \([0-9]+ errors?' "$LINT_LOG" || true; } \
  | { grep -oE '^[0-9]+' || true; } \
  | awk '{ s += $1 } END { print s + 0 }'
