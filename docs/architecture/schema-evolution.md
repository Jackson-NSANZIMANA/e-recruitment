# Schema evolution — how USRP changes its database

**Status:** current practice. Supersedes the `drizzle-kit generate` moratorium
recorded in ADR-021 §D13d (owner decision D15, 2026-07-31).

## The three artefacts

| Artefact | Role |
|---|---|
| `packages/shared-database/src/rls/00NN_*.sql` | **System of record.** Hand-written, fully idempotent SQL. Carries what drizzle cannot express: role grants, FORCE'd RLS policies, immutability triggers, sequences, CHECK constraints, partial indexes. |
| `packages/shared-database/src/schemas/*.schema.ts` | **Readable mirror.** The typed, human-facing model of the same tables. Source of the exported row types. Not the authority. |
| the **latest** `src/migrations/meta/NNNN_snapshot.json` | **Drizzle's belief.** Defines the baseline every future `drizzle-kit generate` diffs against. The drift proof always compares against the highest-numbered snapshot. |

## Why `rls/` is the authority

A database built from the drizzle chain **alone** has no grants, no row-level
security and no triggers — it would violate invariant #1 (cross-agency isolation
enforced at the engine) outright. `bootstrap-db.sh` therefore *always* applies
`rls/0001…` after `db:migrate`, and a drizzle-only database is never a valid
USRP database. Splitting authority between two tools is what produced the drift
this document exists to prevent.

## The snapshot means "post-bootstrap state"

The latest snapshot deliberately describes the database **after the full
bootstrap** (drizzle migrations *plus* every `rls/` file), not the state the
SQL migrations alone would produce. This is what makes `drizzle-kit generate`
meaningful: diffing against an honest baseline yields only genuinely-new
changes.

## Changing the schema

1. **Write the change as a new `rls/00NN_*.sql`**, fully idempotent
   (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ADD VALUE IF NOT EXISTS`,
   `DROP POLICY IF EXISTS` before `CREATE POLICY`). Bootstrap re-runs every
   file on every run; there is no ledger to lean on.
2. **Mirror it** in the matching `*.schema.ts`. Model columns, types,
   nullability, named `idx_*` indexes and enum order. Do *not* model CHECK
   constraints — note them in a comment (`officer_accounts` sets the pattern).
   Name UNIQUE constraints the way drizzle does (`<table>_<column>_unique`).
3. **Refresh the snapshot** — one command, no database needed:
   ```bash
   bash scripts/refresh-schema-snapshot.sh
   ```
   It runs `drizzle-kit generate` in a scratch directory, folds the result into
   the **latest** snapshot preserving its `id` and `prevId`, and discards the
   generated SQL. The SQL is discarded on purpose: `rls/` already applied that
   change, and replaying it would collide on every warm database. Commit the
   updated snapshot file.
4. **Register the change in `bootstrap-db.sh`** (the numbered `apply_sql` list).
5. **Run the gate.** `verify-schema-drift.ts` fails loudly if any of the three
   artefacts moved without the others.

## The guard

`packages/shared-database/selfcheck/verify-schema-drift.ts` asserts both edges
on every gate run:

- **`.ts` ↔ snapshot** — `drizzle-kit generate` into a throwaway directory must
  emit nothing. Catches a schema edit that never reached the snapshot.
- **snapshot ↔ live DB** — tables, columns (name, type, `NOT NULL`), enums
  (labels *and* order) and named `idx_*` indexes must match in both directions.
  Catches the historical failure: a new `rls/` migration nobody mirrored.

It queries `pg_class` / `pg_attribute` rather than `information_schema`, which
is privilege-filtered and would hide a table the proof's role lacks rights on.

## What this replaced

Between `rls/0005` and `rls/0018` the mirror drifted by 27 statements across 7
migrations, discovered only by manual audit. The response at the time was a
prohibition on `drizzle-kit generate`. A prohibition is not an invariant — it
depends on everyone remembering. The reconciled snapshot plus this proof make
the same guarantee enforceable, so the prohibition is retired.
