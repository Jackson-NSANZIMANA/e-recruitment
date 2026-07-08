# ADR-007: age becomes the third projected vetting dimension; the projection reaches the positive terminal

**Status:** Accepted (2026-07-08)
**Owner sign-off:** Jackson NSANZIMANA (continues the ADR-006 ownership fork: extend application-service)
**Extends:** [ADR-006](./ADR-006-application-state-projection.md) — closes its "Age" honest seam.

## Context

ADR-006 gave the application entity a spine: a Kafka projection materialising
NESA/HEC (academic) and RIB (criminal) verdicts onto the row and advancing the
lifecycle. But it stopped, honestly, at `CRIMINAL_CLEARANCE` — the projection
could **reject**, or **hold**, but could never say *"this applicant passed
eligibility."* Two facts, verified against live code this session, explain why:

1. The **age gate emitted only an `AUDIT_ENTRY` shadow** — no
   `applicationId`-bearing result event. So its verdict never reached the
   projection, even though `APPLICANT_SUBMITTED` (which triggers the gate) had
   carried `applicationId` since commit `e2704de`.
2. There was **no age column** on the ops `applications` tables — only
   `academic_status` and `criminal_clearance_status`. Age had nowhere to land.

A worse consequence than "no positive terminal" hid here: because age produced
no application state, **an age-INELIGIBLE applicant who passed academic +
criminal would advance through the pipeline unrejected** — a fail-closed hole.

## Decision

**Age becomes the third first-class, persisted vetting dimension**, mirroring
academic and criminal exactly. Concretely:

- **New result event `AGE_ELIGIBILITY_COMPLETED`** on a new topic `vetting.age`,
  emitted by the eligibility age gate **on the event-driven path only** (where
  `applicationId` is present) — in addition to the existing audit shadow. The
  ad-hoc HTTP age-check, which carries no `applicationId`, stays audit-only.
- **Migration `0006_age_eligibility_columns.sql`** adds `age_eligibility_status`
  (enum `PENDING|ELIGIBLE|INELIGIBLE`), `age_verified_at`, and
  `age_eligibility_detail jsonb` to all three ops schemas.
- The **projection consumer also subscribes to `vetting.age`**; the repository
  projects the age verdict onto the row like any other dimension.
- **`deriveApplicationStatus` gains the age dimension**: age `INELIGIBLE` is a
  hard fail (→ `REJECTED`); and when **all three gates pass** (age `ELIGIBLE` +
  academic `ELIGIBLE` + criminal `CLEARED`) the application reaches the positive
  terminal **`DOCUMENT_REVIEW_GREEN`** — the green (auto-verified-via-G2G) lane.

Age is a **precondition gate, not a ladder stage**: there is no `AGE_VETTING`
value in `ApplicationStatus`, so age gets no intermediate rung. It contributes
exactly two things to the lifecycle — the hard-fail path, and membership in the
all-pass conjunction that unlocks the green terminal. This keeps the change
minimal and the ladder monotonic.

### Alternatives considered

- **Don't persist age; keep it ephemeral.** Rejected: the three gates run in
  parallel and at-least-once, so verdicts arrive in any order. To decide "all
  three passed" when the *last* verdict lands, the earlier two must be durable.
  Age must be a persisted column for order-independent, idempotent projection.
- **Reuse an academic/criminal event.** Rejected: age is a distinct dimension
  with distinct semantics; conflating it would corrupt both audit and lifecycle.

## Compliance invariant carried through

`AgeEligibilityResult` contains the raw `dateOfBirth`. The **DOB never enters
the event or the `age_eligibility_detail` jsonb** — only the derived age,
applied band, verdict, and reason, exactly as the age `AUDIT_ENTRY` already
does (Law N° 058/2021). A dedicated DOB-free payload is constructed at the emit
site; a self-check asserts no `dateOfBirth` key appears in the event or the
stored detail, and that the raw DOB string never leaks into any published event.

## Consequences

- The pipeline now **answers the whole eligibility question**: it reaches a
  *positive* terminal (`DOCUMENT_REVIEW_GREEN`) for the first time, not only
  reject/hold.
- The fail-closed hole is closed: an age-INELIGIBLE applicant is rejected
  regardless of the other gates.
- `partitionKeyForEvent` keys `AGE_ELIGIBILITY_COMPLETED` by `applicantId`
  (present on the event), so it shares an applicant's partition with the other
  verdicts — the single-consumer per-applicant ordering guarantee is preserved,
  no new race.
- No new grant: `0001` grants `usrp_system_service` table-level `UPDATE` on the
  ops schemas, so the new columns are covered.
- Reversible at the adapter/domain layer, like ADR-006: age is one more case in
  the pure `deriveApplicationStatus` and one more branch in the repository.

## Remaining seams (unchanged from ADR-006)

- **Enforced history immutability** — ops `application_status_history` is still
  immutability-by-convention. A trigger mirroring `0002` (now numbered `0007`,
  since `0006` is taken by this migration) remains a recommended compliance
  follow-on.
- `DOCUMENT_REVIEW_AMBER` and everything downstream of document review
  (slot assignment, physical test, medical, final decision) are future stages.

See `docs/architecture/age-integration-terminal-slice.md` for build + proof
detail.
