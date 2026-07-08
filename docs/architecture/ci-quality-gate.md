# CI quality gate — enforce the proofs on every change

**Status:** Done · **Date:** 2026-07-08 · **Touches:** `.github/workflows/ci-backend.yml`,
`scripts/bootstrap-db.sh`, `scripts/run-selfchecks.sh`, root + shared-database `package.json`.

## Why this slice, now

USRP's quality contract is **"prove it, don't assert it"** — every increment
ships a runnable self-check that proves it against live infrastructure. But an
audit of the actual gate found that contract was **not enforced on change**:

1. **CI's `test` job was green-but-hollow.** No package defines a `test` script,
   so `pnpm test` (`turbo run test`) built and reported "6 successful" — running
   **zero tests**. CI's "Unit Tests ✓" asserted a verification that never happened.
2. **CI's `lint` job was hollow too.** `eslint.config.base.mjs` exists but eslint
   is not installed and no package defines a working lint.
3. **The selfchecks — the project's real proof mechanism — ran in NO CI.** The
   RLS cross-agency isolation proof (guardian of the system's first hard
   invariant), the PII round-trip, the identity/eligibility/audit slices: all
   proven **once, by hand, on a developer's machine**, never re-verified. CI
   provisioned Postgres + Redis to run nothing, and had neither Kafka nor the G2G
   mocks the proofs require.
4. **The DB bootstrap was tribal knowledge.** The canonical order
   (`db:migrate → rls/0001 → rls/0002`) lived only in slice docs and memory;
   `setup-dev.sh` stopped at `pnpm install`. Nothing codified it.
5. **Three `db:seed*` scripts pointed at non-existent files** (`run-seeds.ts`,
   `campaigns.seed.ts`, `venues.seed.ts`, `test-applicants.seed.ts` — only
   `exam-venues.seed.ts` exists, and it exports *data*, not a runnable seeder).

A green-but-hollow gate is **worse than no gate**: it tells the owner "verified"
when nothing was. Hardening it protects every guarantee already built and makes
every future slice inherit automatic verification.

## What was built

### `scripts/bootstrap-db.sh` — the canonical bootstrap, codified
Idempotent. Brings an empty Postgres to the fully-provisioned, proven state in
the one correct order: `db:migrate` (drizzle) → apply `rls/0001` (roles, grants,
FORCE'd RLS) → apply `rls/0002` (audit-log immutability), the last two via `psql`
as `usrp_admin` (they need owner privilege). Dev defaults so a plain run works
against tier1; every value overridable by env. Proven idempotent (re-run over an
already-provisioned DB is green — benign "already exists" NOTICEs only).

### `scripts/run-selfchecks.sh` — run every proof, in order, fail-fast
The load-bearing artifact. Runs the RLS isolation `.sql` proof + all 7 service
selfchecks against live infra with one centralized dev env, reporting pass/fail
per proof and exiting non-zero on the first failure. **Proven locally: 8/8
proofs green, ~130 assertions**, spanning cross-agency isolation, PII encryption
at rest, the Kafka backbone, both live services (core + HTTP + event-driven),
NESA education, and audit immutability.

### `package.json` wiring
- Root: `bootstrap:db` → the bootstrap script; **`verify`** → the selfcheck
  runner (the gate, invocable locally and by CI).
- shared-database: the four phantom `db:seed*` scripts replaced by a single
  honest `db:seed` that fails loudly with a pointer here (no runnable seeder
  exists yet — building one is a separate, scoped task, not a silent lie).

### `ci-backend.yml` — honest jobs only
- **Kept** `typecheck` (real, ultra-strict, zero-error gate) and `security-scan`
  (Trivy CRITICAL/HIGH, `exit-code 1`).
- **Removed** the hollow `test` and `lint` jobs.
- **Added `verify`:** checkout → install → `pnpm build` → bring up tier1
  (`--build --wait`) → tier2 (`--wait`) → `pnpm bootstrap:db` → `pnpm verify` →
  dump broker/init logs on failure → tear down. It runs the **same scripts a
  developer runs** — no CI-only reimplementation to drift.

## Proof

Every step the CI `verify` job runs was proven locally before wiring the YAML:
`pnpm build` (9/9), `pnpm bootstrap:db` (idempotent, green), `pnpm verify`
(8/8 proofs, all green). The workflow enforces exactly what was verified by hand.

```bash
pnpm build && pnpm bootstrap:db && pnpm verify   # → ALL PROOFS GREEN ✓
```

## Scope boundaries (deliberate)

- **No eslint revival.** Wiring ESLint across the workspace is its own task;
  removing the hollow `lint` job stops the lie without pretending to fix linting.
  TS strict remains the source-correctness gate (unchanged).
- **No seeder built.** The phantom seed scripts are made honest, not resurrected;
  a real `run-seeds` entrypoint (from the existing venue data + campaigns +
  test-applicants) is a follow-on.
- **CI Kafka is the known risk.** Single-broker Kafka in Actions can be flaky;
  the `verify` job dumps `usrp-kafka`/`kafka-init` logs on failure precisely
  because that is where CI-only failures concentrate (see
  `kafka-backbone-proof.md`). First real CI run may need a broker-timing nudge.

## Follow-ons

- Fold `bootstrap:db` into `setup-dev.sh` so local setup ends in a provable state.
- Build a real `run-seeds` entrypoint; restore `db:seed` to something runnable.
- Wire ESLint (flat config already stubbed) and re-add a real `lint` job.
- Consider caching the mock images to cut `verify` wall-clock.
