# Application status-history immutability (0007)

**Commit (2026-07-09). Mirrors the audit-log immutability pattern (`0002`) for the per-agency status timeline.**

## The gap this closes

Each ops schema's `application_status_history` records every top-level status
transition (null→SUBMITTED at the front door, then each vetting advance/reject
projected by application-service). Its header comment claimed "No UPDATE or
DELETE — INSERT ONLY", but nothing **enforced** it: `0001` granted
`SELECT, INSERT, UPDATE ON ALL TABLES` to `usrp_system_service` (and to each
agency officer on its own schema), so the "immutable" timeline was mutable. For
a national forensic record under Law N° 058/2021, convention is not enough.

## Change — `rls/0007_status_history_immutability.sql`

Two independent guards on all three `<schema>.application_status_history`
tables, exactly like `0002`:

1. **Grants (belt).** `REVOKE UPDATE, DELETE, TRUNCATE` from
   `usrp_system_service` and each owning officer role. The projection only ever
   appends, so nothing legitimate loses a capability. `INSERT`/`SELECT` remain.
2. **Trigger (suspenders).** A `BEFORE UPDATE/DELETE` (row) + `BEFORE TRUNCATE`
   (statement) trigger per schema RAISEs unconditionally — binding the table
   owner and superusers too, which grants cannot. This is the real guarantee.

Written out explicitly per schema (not a loop) so a compliance migration reads
line-by-line. Wired into `bootstrap-db.sh` (step 8). Idempotent.

**Residual (same as `0002`):** a superuser can `DISABLE TRIGGER` or
`SET session_replication_role = replica`. Run services as the non-owner,
non-superuser `usrp_app`; treat superuser access as an HSM/deployment concern.

## Consequence for test teardown (handled)

Enforcing append-only broke the create-and-cleanup selfchecks: three
application-service proofs (`verify-submit-http-slice`, `verify-vetting-projection`,
`verify-pipeline-e2e`) delete their test history rows in teardown, and — via the
`history → applications` FK — could no longer delete the applications either.
Their cleanups now wrap the teardown deletes in a single superuser transaction
with `SET LOCAL session_replication_role = replica` (disables the immutability
**and** FK triggers for that maintenance tx only; snaps back on commit). This is
the documented escape hatch used deliberately and locally — never in the
service code paths.

## Proof

New `services/application-service/selfcheck/verify-history-immutability.ts`
(registered in `run-selfchecks.sh`): appends a row as `usrp_system_service`;
attempts UPDATE/DELETE/TRUNCATE **as the table owner** and asserts each is
rejected; confirms the row survives untampered; introspects grants
(INSERT+SELECT present, UPDATE/DELETE absent). `bash scripts/bootstrap-db.sh &&
bash scripts/run-selfchecks.sh` → **14/14 green, zero regression**.
