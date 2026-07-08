# Application-State Projection — the pipeline's spine

**Status:** DONE, proven against live Kafka + Postgres. Implements
[ADR-006](adrs/ADR-006-application-state-projection.md). Registered in
`scripts/run-selfchecks.sh`.

## The gap this closed

`vetting.nesa` / `vetting.hec` / `vetting.rib` had **no consumers**, and nothing
wrote application state after the front door — `status`, `academic_status`,
`criminal_clearance_status` never moved from their defaults. The vetting gates
rendered verdicts nobody read. This slice makes application-service the **single
owner of application state** and adds an event-projection adapter that
materialises those verdicts onto the application row.

```
publish NESA/HEC/RIB verdict ─► [application-service projection consumer]
     (vetting.nesa/hec/rib)                    │
                                               ▼
   ops applications row advanced (academic_status / criminal_clearance_status /
   status + *_at + request-ids), application_status_history appended on a status
   transition, AUDIT_ENTRY emitted → audit-service persists it.
```

## What was built (all additive; the front-door submit path is untouched)

Under `services/application-service/`:

- `src/domain/agency-schema.ts` — the `AGENCY_TARGET` (agency→`rdf_ops`/`rnp_ops`/
  `rcs_ops`) map, lifted out of the repository so both the front door and the
  projector share one source of truth for schema routing (the isolation boundary).
- `src/domain/lifecycle.ts` — **pure** `deriveApplicationStatus(current,
  {academicStatus, criminalStatus})`: monotonic (max-rank, never regresses),
  fail-closed (`INELIGIBLE` / `FLAGGED_*` → `REJECTED`), stops at
  `CRIMINAL_CLEARANCE` (the age seam). Total, I/O-free, unit-testable.
- `src/ports/application-repository.ts` — extended with `applyVettingResult` +
  the `VettingResult` (academic/criminal) and `ApplyVettingOutcome`
  (`APPLIED` / `NO_CHANGE` / `NOT_FOUND`) types.
- `src/adapters/application.pg-repository.ts` — `applyVettingResult`: `sql.begin`
  → `SET LOCAL ROLE usrp_system_service` → resolve schema from `agency` →
  `SELECT … FOR UPDATE`. 0 rows → `NOT_FOUND` (cross-agency guard). Compute the
  column + `deriveApplicationStatus`; `NO_CHANGE` when nothing moves (idempotent).
  Else UPDATE (verdict column + `*_at` + request-id + `academic_eligibility_detail`
  jsonb + RNP-only `applied_criminal_threshold` + `status` + `updated_at`), and
  append a history row **only when the top-level status transitions**.
- `src/application/project-vetting-result.service.ts` — the use case: on `APPLIED`
  emits an `AUDIT_ENTRY` (`APPLICATION_STATUS_ADVANCED` / `APPLICATION_REJECTED` /
  `APPLICATION_VERDICT_RECORDED`, with `previousStatus`/`newStatus`); no-op on
  `NO_CHANGE`/`NOT_FOUND`.
- `src/adapters/events/vetting-result.consumer.ts` — consumer group
  `application-service` on `[vetting.nesa, vetting.hec, vetting.rib]`; maps each
  event → normalized `VettingResult`; propagates faults (offset uncommitted).
- `src/index.ts` — `createApplicationService` now returns `{ submit, projector }`
  (two adapters, one shared repository). `src/main.ts` — wires the consumer when
  `KAFKA_BROKERS` is set; readiness stays `SELECT 1`.

**No DB migration** — `usrp_system_service` already holds `UPDATE` on the ops
schemas and `INSERT` on the history tables (verified: `0001_roles_grants_rls.sql:30`).

## Key design decisions

- **One writer for the aggregate.** Front door INSERTs, projector UPDATEs,
  through one `PgApplicationRepository` — no split-brain on a row.
- **Idempotent + order-independent + monotonic + fail-closed** — see ADR-006.
- **Cross-agency guard in code, not the engine.** Ops `applications` have no RLS;
  the agency *is* the schema. A mis-routed `applicationId` yields 0 rows →
  `NOT_FOUND`, never a silent cross-schema write.
- **History = status timeline; audit = every change.** A status-history row is
  written only on a top-level `status` transition; the `AUDIT_ENTRY` captures
  every applied verdict (including column-only changes, e.g. academic landing
  after the status already advanced on criminal).
- **Traceability bonus** — persists `nesa_/hec_/rib` request-ids and the
  `EligibilityResult` into `academic_eligibility_detail`.

## Proof (`selfcheck/verify-vetting-projection.ts`, live Kafka + PG)

Seeds a VERIFIED applicant + open RDF/RNP campaigns, files SUBMITTED
applications through the real repository, then drives projections over live
Kafka and verifies DB + history + audit:
1. **Academic (NESA)** → `academic_status=ELIGIBLE`, `nesa_verified_at`,
   `status→ACADEMIC_VETTING`, history `SUBMITTED→ACADEMIC_VETTING`,
   `APPLICATION_STATUS_ADVANCED` audit.
2. **Academic (HEC)** → `hec_verified_at` set (NESA column untouched).
3. **Criminal (RIB CLEARED)** → `criminal_clearance_status=CLEARED`,
   `criminal_clearance_at`, `status→CRIMINAL_CLEARANCE`.
4. **Hard fail (FLAGGED_CONVICTION)** → `status→REJECTED`, `APPLICATION_REJECTED`.
5. **RNP UNDER_REVIEW** → `applied_criminal_threshold` persisted, review is not a
   fail (`status→CRIMINAL_CLEARANCE`).
6. **Idempotency** — redeliver academic verdict → no extra history row, no state
   change.
7. **Order-independence** — criminal before academic → final `CRIMINAL_CLEARANCE`,
   `academic_status=ELIGIBLE`, no regressive `ACADEMIC_VETTING` history row.
8. **Cross-agency guard** — RNP-labelled event for an RDF app → RDF row untouched,
   no rnp_ops row created.

Registered in `scripts/run-selfchecks.sh` → gate green. Full `pnpm -r build`
clean; compiled `node dist/main.js` consumes the three topics + graceful SIGTERM.

## Follow-ons (seams left open, by design)

- **Age integration** — add `AGE_ELIGIBILITY_COMPLETED` (age gate already carries
  `applicationId`) so the composition can reach the positive terminal past
  `CRIMINAL_CLEARANCE`.
- **Enforced history immutability** — `0006_status_history_immutability.sql`
  mirroring the audit-table triggers (0002).
- **`.env`/three-role-model** reconciliation (standing item).
