# Age integration — completing the lifecycle to the positive terminal

**Commit series (2026-07-08). Implements [ADR-007](./adrs/ADR-007-age-eligibility-dimension.md); extends [ADR-006](./adrs/ADR-006-application-state-projection.md).**

## What this slice does

Closes ADR-006's "Age" honest seam. The application-state projection previously
consumed only academic (NESA/HEC) and criminal (RIB) verdicts and could advance
no further than `CRIMINAL_CLEARANCE`. This slice makes **age the third persisted
vetting dimension**, so the projection reaches the positive terminal
`DOCUMENT_REVIEW_GREEN` when age + academic + criminal all pass — and rejects an
age-INELIGIBLE applicant (a fail-closed hole that previously let age-ineligible
applicants advance).

```
APPLICANT_SUBMITTED ─► eligibility age gate ─► AGE_ELIGIBILITY_COMPLETED
   (carries applicationId)     │                    (vetting.age)
                               │                          │
                               └► AUDIT_ENTRY             ▼
                                             [application-service projection]
                                                          │
   age_eligibility_status/at/detail set; status recomputed via the 3-dimension
   deriveApplicationStatus; all-pass → DOCUMENT_REVIEW_GREEN; history + AUDIT_ENTRY.
```

## Changes by layer

| Layer | File(s) | Change |
|---|---|---|
| Contracts | `packages/shared-types/src/eligibility.types.ts`, `events.types.ts` | `AgeEligibilityStatus`; `AgeEligibilityCompletedEvent`; `KAFKA_TOPICS.VETTING_AGE`; union member |
| Routing | `packages/shared-events/src/topics.ts` | `AGE_ELIGIBILITY_COMPLETED → vetting.age` (exhaustive map); partition key = `applicantId` (inherited) |
| Persistence | `packages/shared-database/src/rls/0006_age_eligibility_columns.sql` + 3 `*-ops.schema.ts` | age enum + `age_eligibility_status`/`age_verified_at`/`age_eligibility_detail` on rdf/rnp/rcs; index each |
| Emit | `services/eligibility-service/.../evaluate-age-eligibility.service.ts`, `applicant-submitted.consumer.ts` | optional `applicationId`; when present, emit `AGE_ELIGIBILITY_COMPLETED` (DOB-free) alongside the audit shadow |
| Project | `services/application-service/src/domain/lifecycle.ts`, `ports/application-repository.ts`, `adapters/application.pg-repository.ts`, `adapters/events/vetting-result.consumer.ts`, `application/project-vetting-result.service.ts` | age in `VettingEvidence`; hard-fail + all-pass→`DOCUMENT_REVIEW_GREEN`; `AgeVettingResult`; AGE UPDATE branch; subscribe `vetting.age` |
| Infra | `infrastructure/docker/docker-compose.tier2.yml`, `scripts/bootstrap-db.sh` | `vetting.age:6` topic; apply `0006` |

## Key decisions

- **Age is a precondition gate, not a ladder stage.** No `AGE_VETTING` value
  exists in `ApplicationStatus`; age contributes only the hard-fail path and
  membership in the all-pass conjunction. `deriveApplicationStatus` stays pure,
  total, monotonic; `DOCUMENT_REVIEW_GREEN` is the new top ladder rung.
- **Age must be persisted.** Verdicts arrive in any order; to decide "all three
  passed" when the last one lands, the earlier two must be durable columns.
- **DOB never leaves the gate.** The event and jsonb carry only derived age /
  band / verdict — same protection as the existing age audit entry.
- **HTTP age-check stays audit-only** (no `applicationId`); the result event is
  emitted only on the event-driven path.

## Proof (the gate is the arbiter)

`bash scripts/bootstrap-db.sh` (now applies `0006`, proven idempotent on re-run)
then `bash scripts/run-selfchecks.sh` → **12/12 green, zero regression**; `pnpm
-r build` clean.

Extended proofs:

- **`services/application-service/selfcheck/verify-vetting-projection.ts`** — new
  live scenarios: age-only verdict holds at `SUBMITTED` (no age rung); all three
  pass → `DOCUMENT_REVIEW_GREEN` (history row + `APPLICATION_STATUS_ADVANCED`
  audit with `newStatus=DOCUMENT_REVIEW_GREEN`); academic+criminal pass with age
  PENDING **holds at `CRIMINAL_CLEARANCE`** (age gates the terminal); age
  `INELIGIBLE` → `REJECTED`; `age_eligibility_detail` is DOB-free.
- **`services/eligibility-service/selfcheck/verify-age-eligibility.ts`** — new
  scenario: the event-driven path emits `AGE_ELIGIBILITY_COMPLETED` bearing the
  `applicationId`, DOB-free, alongside the audit entry; the HTTP path emits only
  `AUDIT_ENTRY`.

## Notes for the next engineer

- `kafka-init` creates topics only at first boot. On an already-running tier2,
  create `vetting.age` once: `docker exec usrp-kafka kafka-topics --create
  --if-not-exists --topic vetting.age --partitions 6 --replication-factor 1
  --bootstrap-server kafka:9092`. Fresh environments get it from the compose edit.
- `0006` (a hand-written idempotent SQL file, per the `0005` convention) took the
  `0006` slot originally floated for the history-immutability trigger; that
  becomes `0007`.
