# ADR-006: application-service owns application state; a Kafka projection materialises vetting verdicts

**Status:** Accepted (2026-07-08)
**Owner sign-off:** Jackson NSANZIMANA (ownership fork chosen: extend application-service)

## Context

USRP's vetting gates (identity, age, NESA, HEC, RIB, audit) were each proven
correct in isolation, but a live-code audit exposed a systemic gap: **the
application entity was a phantom.**

- The result topics `vetting.nesa`, `vetting.hec`, `vetting.rib` had **zero
  consumers** — every NESA/HEC/RIB verdict was published into the void (only its
  separate `AUDIT_ENTRY` shadow was ever read).
- **Nothing wrote application state after the front door.** The only
  post-creation write was the opening status-history row. `status`,
  `academic_status`, `criminal_clearance_status` stayed at their defaults and
  never moved. The lifecycle enum (`SUBMITTED → ACADEMIC_VETTING →
  CRIMINAL_CLEARANCE → …`) was inert.

The system could not answer its reason for existing: *"is applicant X eligible,
and where are they in the process?"*

## Decision

**application-service becomes the single owner of application state.** A new
event-projection adapter (consumer group `application-service`) subscribes to
`vetting.nesa`, `vetting.hec`, `vetting.rib`, and materialises each verdict onto
the application row: `academic_status` / `criminal_clearance_status`, their
`*_at` timestamps and request-ids, the top-level lifecycle `status`, and an
appended `application_status_history` row on each status transition — then emits
an `AUDIT_ENTRY` of the state change.

The `applications` table therefore has **one writing owner** with two adapters
over one aggregate: the HTTP front door (INSERT / create) and the event
projector (UPDATE / advance), sharing one `PgApplicationRepository`.

### Alternatives considered

- **New dedicated orchestrator service** — rejected: it would make two services
  write the same `applications` table (INSERT vs UPDATE), splitting ownership of
  one aggregate and complicating the compliance-sensitive write path.
- **Each gate writes its own column** — rejected: scatters application-state
  ownership across four services and makes lifecycle composition impossible (no
  single place to compute "advance vs reject").

## Two verified facts that shaped the implementation

1. **No migration was needed for the write.** `usrp_system_service` already
   holds `SELECT, INSERT, UPDATE` on all three ops schemas
   (`shared-database/src/rls/0001_roles_grants_rls.sql:30`), covering
   `applications` and `application_status_history`.
2. **The ops `applications` tables have no row-level security** — isolation is by
   schema GRANT, not row policy. The agency *is* the schema; there is nothing to
   `SET LOCAL` beyond the role. The engine will **not** stop a mis-routed
   cross-agency write, so that guard is application code's responsibility (below).

## Design rules (the invariants this ADR commits to)

- **Monotonic lifecycle.** The gates run in parallel and at-least-once, so
  verdicts arrive in any order and may be redelivered. The top-level `status` is
  the furthest stage the evidence justifies, computed by max-rank in a pure,
  total `deriveApplicationStatus` — it never regresses.
- **Fail-closed.** Academic `INELIGIBLE` or any criminal `FLAGGED_*` →
  `REJECTED` (terminal). `UNDER_REVIEW` is a HOLD (reaches the criminal stage,
  never auto-rejects).
- **Idempotent.** The repository reads the row `FOR UPDATE`, and writes nothing
  when neither the target column nor the status would change (`NO_CHANGE`) — so
  redelivery is a silent no-op (no duplicate history, no duplicate audit).
- **Cross-agency guard.** The projector resolves the ops schema from the event's
  `agency` and `UPDATE … WHERE id = applicationId` in that schema; a `SELECT …
  FOR UPDATE` that returns 0 rows yields `NOT_FOUND` (mis-route or unknown app) —
  never a silent success. Proven by a self-check that mis-labels an RDF app's
  event as RNP and asserts the RDF row is untouched and no RNP row appears.
- **History records status transitions only.** An `application_status_history`
  row is appended only when the top-level `status` enum changes; per-dimension
  column changes are captured by the emitted `AUDIT_ENTRY`.
- **Propagate on fault.** A projection fault propagates out of the consumer so
  the Kafka offset is uncommitted and the verdict is redelivered.

## Honest seams (explicitly out of scope; follow-ons)

- **Age.** The age gate emits only an audit shadow — no `applicationId`-bearing
  result event. So the *positive terminal* ("all gates passed → advance past
  `CRIMINAL_CLEARANCE` to `DOCUMENT_REVIEW`") is deferred. This slice advances
  only as far as the academic+criminal evidence justifies and rejects on hard
  fail. Next: add `AGE_ELIGIBILITY_COMPLETED` (the age consumer already has
  `applicationId`) and complete the composition.
- **Enforced history immutability.** Ops `application_status_history` is
  immutability-by-convention only (no trigger, unlike `audit_log` under `0002`).
  A `0006_status_history_immutability.sql` mirroring 0002 is a recommended
  compliance follow-on (it *restricts* the surface).

## Consequences

- The pipeline now has a spine: vetting verdicts move the application through
  its lifecycle, and the per-dimension columns + history + audit trail make an
  applicant's state and timeline queryable.
- application-service gains a Kafka consumer (previously a pure producer); its
  readiness remains DB reachability.
- Reversible at the adapter layer: the projection is an adapter over the same
  hexagonal core; the ownership decision does not leak into the domain.

See `docs/architecture/application-state-projection-slice.md` for the build +
proof detail.
