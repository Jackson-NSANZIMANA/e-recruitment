#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
# refresh-schema-snapshot.sh — schema-evolution step 3, as ONE command.
#
# After you add an rls/00NN file and mirror it in a *.schema.ts, drizzle's
# LATEST snapshot must learn about it or verify-schema-drift.ts goes red (by
# design). The documented manual fold was: generate, copy the new snapshot
# over the latest one keeping its id/prevId, delete the generated SQL. Done by
# hand that is three chances to commit a replayable migration by accident.
#
# This does it in a scratch dir (same technique as the drift proof), so the
# real src/migrations is never a generate target:
#   1. copy meta/ to scratch, run `drizzle-kit generate` there;
#   2. no new snapshot  ⇒ already in sync, exit 0;
#   3. else write the new snapshot over the LATEST committed one, preserving
#      that file's id and prevId; discard the generated SQL and journal entry.
#
# Needs no database. Run from anywhere:  bash scripts/refresh-schema-snapshot.sh
# Then commit packages/shared-database/src/migrations/meta/<latest>_snapshot.json
# ══════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="${REPO_ROOT}/packages/shared-database"
META="${PKG}/src/migrations/meta"
KIT="${PKG}/node_modules/.bin/drizzle-kit"
SCRATCH="${PKG}/.snapshot-refresh"

[[ -x "$KIT" ]] || { echo "drizzle-kit not found at $KIT — run pnpm install first" >&2; exit 1; }

LATEST="$(ls "$META" | grep -E '^[0-9]+_snapshot\.json$' | sort | tail -1)"
[[ -n "$LATEST" ]] || { echo "no snapshot in $META" >&2; exit 1; }

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH/out"
trap 'rm -rf "$SCRATCH"' EXIT
cp -R "$META" "$SCRATCH/out/meta"

cat > "$SCRATCH/refresh.config.ts" <<EOF
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: '${PKG}/src/schemas/*.schema.ts',
  out: 'out',
  migrations: { table: 'drizzle_migrations', schema: 'public' },
  strict: true,
});
EOF

(cd "$SCRATCH" && "$KIT" generate --config=refresh.config.ts --name=snapshot_refresh)

NEW="$(ls "$SCRATCH/out/meta" | grep -E '^[0-9]+_snapshot\.json$' | sort | tail -1)"
if [[ "$NEW" == "$LATEST" ]]; then
  echo "✓ snapshot already agrees with the .ts schemas — nothing to fold"
  exit 0
fi

node -e '
  const fs = require("node:fs");
  const [latestPath, newPath] = process.argv.slice(1);
  const latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
  const fresh = JSON.parse(fs.readFileSync(newPath, "utf8"));
  fresh.id = latest.id;
  fresh.prevId = latest.prevId;
  fs.writeFileSync(latestPath, JSON.stringify(fresh, null, 2) + "\n");
' "$META/$LATEST" "$SCRATCH/out/meta/$NEW"

echo "✓ folded the regenerated snapshot into $LATEST (id/prevId preserved; generated SQL discarded)"
echo "  commit: packages/shared-database/src/migrations/meta/$LATEST"
