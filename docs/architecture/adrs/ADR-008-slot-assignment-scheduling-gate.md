# ADR-008: scheduling is a post-eligibility stage gate; the projection ladder becomes the single source of monotonicity

**Status:** Accepted (2026-07-09)
**Owner sign-off:** Jackson NSANZIMANA (continues the ADR-006 ownership fork: application-service is the single writer of application state)
**Extends:** [ADR-006](./ADR-006-application-state-projection.md) (single-writer projection), [ADR-007](./ADR-007-age-eligibility-dimension.md) (the positive terminal `DOCUMENT_REVIEW_GREEN`)

## Context

ADR-007 brought the application to its first positive terminal,
`DOCUMENT_REVIEW_GREEN` — "age + academic + criminal all passed via G2G." That is
the end of *eligibility*, not the end of the applicant's journey. The next real
forward motion for an accepted applicant is **scheduling**: being assigned an
exam venue and issued an invitation. This slice extends the lifecycle
`DOCUMENT_REVIEW_GREEN → SLOT_ASSIGNED`.

Two structural questions had to be answered without violating the invariants:

1. **Who assigns the slot?** Assignment needs the applicant's home *district*
   (encrypted PII on the shared identity) resolved to a public exam *venue*. That
   is a distinct concern from owning application state.
2. **How does the status advance without corrupting the pure vetting lifecycle?**
   `deriveApplicationStatus` is the pure conjunction of the three vetting gates;
   scheduling is not a vetting verdict and must not be folded into it.

## Decision

**Scheduling is a new event-driven stage gate (`scheduling-service`), mirroring
the `background-vetting-service` archetype; application-service remains the single
writer** (ADR-006). The gate *decides* the venue; the projection *applies* it.

Flow:

```
projection reaches DOCUMENT_REVIEW_GREEN
   └► APPLICATION_ELIGIBILITY_CLEARED  (application.cleared)          [application-service emits]
        └► scheduling-service: decrypt home district → resolve venue → mint opaque QR
             └► SLOT_ASSIGNED  (slot.assigned)                        [scheduling-service emits]
                  └► application-service slot projection
                       └► applications: venue fields + status SLOT_ASSIGNED + history + AUDIT_ENTRY
```

Concretely:

- **Trigger event** `APPLICATION_ELIGIBILITY_CLEARED` (topic `application.cleared`)
  is emitted by the vetting projection **only on the genuine transition into**
  `DOCUMENT_REVIEW_GREEN` (guarded on `statusChanged`), so redelivery does not
  re-fire it. It carries `applicationId, applicantId, agency, campaignId, category`
  — everything scheduling needs, no PII.
- **Venue reference data** reuses the pre-existing `public_core.campaign_venue_assignments`
  table (already modelled in the baseline migration, keyed uniquely on
  `(campaign_id, district)`); `rls/0008` adds only `GRANT SELECT` to
  `usrp_system_service` (no new table). Deterministic district→venue lookup, no
  capacity model this slice.
- **scheduling-service** is consumer-only (no HTTP surface): consumes
  `application.cleared`, decrypts `encrypted_home_district` (transaction-local
  pgcrypto as `usrp_system_service`, mirroring the eligibility identity reader),
  resolves the venue, mints an opaque URL-safe QR token (`randomBytes(32)`),
  emits `SLOT_ASSIGNED` + `AUDIT_ENTRY`. Config: runtime + db + PII key only.
- **Slot projection** is a *second, separate* projection path on application-service
  (`applySlotAssignment`), NOT folded into `deriveApplicationStatus`. It transitions
  **only** from `DOCUMENT_REVIEW_GREEN`; any other status holds (idempotent
  redelivery of a `SLOT_ASSIGNED` row → `NO_CHANGE`; not-yet-green/terminal →
  `NOT_ASSIGNABLE`). Cross-agency guard by schema, like the vetting projection.

### The monotonicity correction (the load-bearing fix)

Separating the slot projection from the vetting conjunction is correct — but it
exposed a latent defect that the original plan did not foresee. `deriveApplicationStatus`
guarantees the top-level status is **monotonic (never regresses)**. It computed
that guarantee against a *local* ladder that stopped at `DOCUMENT_REVIEW_GREEN`,
ranking any further-along status (`SLOT_ASSIGNED`, `PHYSICAL_TEST_SCHEDULED`, …)
as `indexOf → -1` — i.e. *earlier* than every vetting stage.

Consequence: a **redelivered all-pass vetting event** (ordinary at-least-once
Kafka behaviour; there is no cross-topic ordering guarantee between `vetting.*`
and `slot.assigned`) on an already-`SLOT_ASSIGNED` row would recompute the status
as `DOCUMENT_REVIEW_GREEN`, **regress the row backward**, append a false backward
history entry, and **re-emit `APPLICATION_ELIGIBILITY_CLEARED` → re-trigger
scheduling → mint a second QR**, silently invalidating the invitation the
applicant already held. Every downstream status was equally vulnerable.

**Fix:** the monotonicity rank is now taken from the **canonical lifecycle order**
(`@usrp/shared-types` `APPLICATION_STATUSES`) — the single source of truth for how
far along a status is. The projection still only ever *proposes* candidates up to
`DOCUMENT_REVIEW_GREEN`, but it now *knows* a row may already be further along and
refuses to regress it. Fail-closed disqualification (hard fail → `REJECTED`) is
deliberately unchanged. This keeps the pure vetting lifecycle pure while making
the invariant it advertises actually true.

## Decisions locked (surfaced for sign-off)

- New `scheduling-service`, not an extension of application-service — preserves
  ADR-006 ownership. Scheduling emits; the projection applies.
- New `application.cleared` trigger — the first "stage N complete" signal on the
  backbone. The vetting `deriveApplicationStatus` stays pure.
- Deterministic `(campaign_id, district)` → venue lookup; no capacity this slice.
- Opaque random QR token this slice; a cryptographically signed/verifiable QR is
  a deferred follow-on.
- `NO_VENUE` (e.g. RNP, whose venue list is not published, or an unseeded
  district) **holds at `DOCUMENT_REVIEW_GREEN`** with a `SLOT_ASSIGNMENT_DEFERRED`
  audit — honest, never a fabricated venue.

## Consequences

- The lifecycle now reaches `SLOT_ASSIGNED`. `PHYSICAL_TEST_SCHEDULED` and beyond
  remain open seams.
- The monotonicity fix means any future post-eligibility stage added the same way
  (its own projection path advancing past a terminal the vetting gates can't) is
  automatically safe from vetting-redelivery regression — the ladder is now the
  one ordering everyone shares.
- **Compliance:** the raw home district never enters a cross-service event or log
  — only the resolved public venue does. The district is recorded in the internal
  audit trail (a legitimate forensic record) on the `NO_VENUE` deferral only.
- **Known limitation:** a `NO_VENUE` application is not automatically re-scheduled
  when a venue is later seeded (the `application.cleared` event already fired and
  committed). Re-trigger is a manual/admin concern until a scheduling re-drive
  exists.

## Verification

- Pure-domain proof `verify-lifecycle.ts` — the monotonicity invariant, exhaustive
  across the canonical order (failed 7 assertions pre-fix, green post-fix).
- `verify-slot-assignment.ts` — live Kafka + PG: `ASSIGNED` (venue resolved, QR
  minted, no district leak) and `NO_VENUE` deferral paths.
- `verify-pipeline-e2e.ts` (extended) — one real submission drives
  age→academic→criminal→GREEN→`SLOT_ASSIGNED` end-to-end, no synthetic events.
  NOTE (2026-07-10): this proof was long dismissed as a "single-broker flake." It
  was actually catching a real defect — the slot consumer shared the vetting
  consumer group with a divergent subscription, causing perpetual rebalancing.
  Fixed by giving the slot projection its own group; the proof is now
  deterministic (10/10, ~14s) and the gate is 17/17. See
  [pipeline-convergence-fix.md](../pipeline-convergence-fix.md).
