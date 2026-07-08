# The autonomous eligibility pipeline — academic gate event-driven + full-chain proof

**Commit series (2026-07-08). Follows [ADR-007](./adrs/ADR-007-age-eligibility-dimension.md); closes the NESA/HEC event-driven seam left open in [ADR-006](./adrs/ADR-006-application-state-projection.md).**

## The defect this closes

A live-code trace of what actually fires on a real `APPLICANT_SUBMITTED` found
that only **two of three** vetting gates were event-driven:

| Gate | Consumed `applicant.submitted`? |
|---|---|
| Age (eligibility) | ✅ |
| Criminal (background-vetting) | ✅ |
| **Academic (NESA/HEC)** | ❌ **HTTP-only** (`eligibility-service/src/main.ts` said so in a comment) |

So `academic_status` never left `PENDING` from the backbone, the projection
stalled at `CRIMINAL_CLEARANCE`, and the `DOCUMENT_REVIEW_GREEN` terminal added
in ADR-007 was **unreachable in the real system**. The isolated self-checks hid
this: the projection proof fabricated the academic event itself. Proving the
pieces is not proving the whole.

## Change

### Academic gate event-driven
- **New** `services/eligibility-service/src/adapters/events/academic-vetting.consumer.ts`
  — consumer group `eligibility-academic` (deliberately **separate** from the
  age gate's group so a NESA/HEC outage retries only the academic reaction, not
  the already-succeeded age gate). Routes each submission by the credential the
  event carries: `nesaIndexNumber` → NESA gate (`education.verify`),
  `hecRegistrationNumber` → HEC gate (`degree.verify`). Zero new event data.
- **Fault vs fail:** a G2G outage (`NesaUnavailableError`/`HecUnavailableError`)
  propagates → offset uncommitted → redelivery. A missing record is a business
  outcome — the gate has already emitted a fail-closed `INELIGIBLE` completion
  event, so the offset commits and the projection rejects.
- Wired in `main.ts` (both gates now start under `KAFKA_BROKERS`); exported from
  `index.ts`.

### The whole spine, proven
- **New** `services/application-service/selfcheck/verify-pipeline-e2e.ts` — the
  first cross-service proof. It wires the **real** eligibility (age + academic)
  and background-vetting (criminal) consumers and the projection consumer on
  live Kafka, files **one real front-door submission**, and asserts the row
  reaches `DOCUMENT_REVIEW_GREEN` with all three dimensions set — **no synthetic
  vetting events**. A second submission with an unknown NESA index proves the
  fail path → `REJECTED`. Registered last in `run-selfchecks.sh` (→ 13 proofs).
  `@usrp/eligibility-service` + `@usrp/background-vetting-service` are added as
  **devDependencies** (dev-only; not shipped) of application-service for this.
- The existing `verify-event-driven.ts` was extended to a unit-level guard: one
  submission now fans out to BOTH the age AUDIT_ENTRY and a
  `NESA_VERIFICATION_COMPLETED` on `vetting.nesa`, sharing one causal chain.

## Proof (the arbiter)

`bash scripts/bootstrap-db.sh && bash scripts/run-selfchecks.sh` →
**13/13 green, zero regression**; `pnpm -r build` clean. Observed live in the
pipeline proof: one submission → `academic_vetted (NESA, EVALUATED)` +
`applicant_submitted_processed (age, EVALUATED)` + `criminal_clearance_vetted
(CLEARED)` → projection `SUBMITTED → ACADEMIC_VETTING → DOCUMENT_REVIEW_GREEN`.

## What this establishes

- The pipeline is **autonomous end-to-end**: a submission alone drives all three
  gates and a positive or negative eligibility terminal — no manual HTTP call.
- A standing **full-chain regression guard** exists, so the "pieces work, the
  composition doesn't" class of defect can't silently return.

## Notes for the next engineer

- The academic gate has TWO ingresses now: the event consumer (autonomous
  pipeline) and the HTTP controllers (ad-hoc checks). Both call the same use
  cases; only the event path is part of the automatic flow.
- The pipeline proof reuses the real consumer-group names; keep it running
  serially in the gate (as registered) so it doesn't contend with other proofs.
