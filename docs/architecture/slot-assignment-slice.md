# Slot-assignment slice — `DOCUMENT_REVIEW_GREEN → SLOT_ASSIGNED`

**Status:** implemented, in-flight on branch `feat/autonomous-eligibility-pipeline` (uncommitted at time of writing).
**ADR:** [ADR-008](./adrs/ADR-008-slot-assignment-scheduling-gate.md). **Extends:** ADR-006 (single-writer projection), ADR-007 (positive terminal).

## What this slice does

Extends the applicant lifecycle one real stage past eligibility: an application
that reaches `DOCUMENT_REVIEW_GREEN` is autonomously assigned an exam **venue**
(resolved from the applicant's home district) and issued an opaque **QR
invitation**, landing at `SLOT_ASSIGNED`.

```
[application-service projection] reaches DOCUMENT_REVIEW_GREEN
   └► APPLICATION_ELIGIBILITY_CLEARED (application.cleared)
        └► [scheduling-service]  decrypt home district → resolve venue → mint QR
             └► SLOT_ASSIGNED (slot.assigned)
                  └► [application-service slot projection]
                       venue fields + status=SLOT_ASSIGNED + history row + AUDIT_ENTRY
```

## Components

| Layer | Where | Notes |
|---|---|---|
| Trigger event | `shared-types` `ApplicationEligibilityClearedEvent`, topic `application.cleared` | emitted by the vetting projection **only** on the genuine transition into `DOCUMENT_REVIEW_GREEN` (guarded on `statusChanged`). Carries `applicationId, applicantId, agency, campaignId, category` — no PII. |
| Venue data | `public_core.campaign_venue_assignments` (pre-existing, baseline migration) | unique `(campaign_id, district)`; `rls/0008` = `GRANT SELECT` to `usrp_system_service` only (no new table). `venues.seed.ts` seeds it out-of-band; selfchecks provision their own rows. |
| Gate | `services/scheduling-service` | consumer-only (no HTTP). Decrypts `encrypted_home_district` (tx-local pgcrypto as `system_service`), resolves venue, mints `randomBytes(32)` URL-safe QR, emits `SLOT_ASSIGNED` + `AUDIT_ENTRY`. Config: runtime + db + PII key. |
| Slot projection | `application-service` `applySlotAssignment` + `slot-assigned.consumer.ts` | second projection path, **separate** from `deriveApplicationStatus`. Transitions only from `DOCUMENT_REVIEW_GREEN`; idempotent/hold-safe. |

## Business outcomes (return values, not exceptions)

- `ASSIGNED` — venue resolved, `SLOT_ASSIGNED` emitted, row stamped.
- `NO_VENUE` — no venue for this `(campaign, district)` (e.g. RNP unpublished, or an
  unseeded district). Emits `SLOT_ASSIGNMENT_DEFERRED` audit, **no** `SLOT_ASSIGNED`;
  application **holds at green** for manual handling. Never fabricates a venue.
- `APPLICANT_NOT_FOUND` — identity missing/erased.
- Infra faults (`SchedulingReadError`, publish failure) propagate → offset
  uncommitted → redelivery.

## The monotonicity invariant (read before touching the lifecycle)

`deriveApplicationStatus` promises the top-level status is **monotonic**. Because
scheduling advances the row *past* the terminal the vetting gates produce, the
monotonicity rank MUST be taken from the **canonical `APPLICATION_STATUSES`
order**, not a local vetting-only ladder. A truncated ladder ranks downstream
statuses as `-1` and lets a **redelivered vetting event regress a `SLOT_ASSIGNED`
row back to green** — re-firing scheduling and re-minting the QR. This was a real,
reproduced defect; the fix and its guard proof (`verify-lifecycle.ts`) exist
precisely so it cannot silently return. Do not reintroduce a short ladder.

## Compliance

Raw home district never appears in a cross-service event or log — only the
resolved public venue does. The district is written to the internal audit trail
on the `NO_VENUE` deferral only (a legitimate forensic record). QR is an opaque
token.

## Proofs

- `services/application-service/selfcheck/verify-lifecycle.ts` — **pure**,
  deterministic monotonicity proof (the authoritative guard for this seam).
- `services/scheduling-service/selfcheck/verify-slot-assignment.ts` — live Kafka+PG:
  `ASSIGNED` (GASABO seeded venue → QR, no district leak) and `NO_VENUE` (KIREHE, no
  venue) deferral.
- `services/application-service/selfcheck/verify-pipeline-e2e.ts` — extended full
  chain: one submission → age+academic+criminal → GREEN → `SLOT_ASSIGNED`.

Bootstrap applies `0008`; both new proofs are registered in `run-selfchecks.sh`.

## Known issues / open seams

- **~~Pipeline e2e flake~~ — RESOLVED (2026-07-10).** This was NOT a
  test-harness flake. `verify-pipeline-e2e.ts` was catching a real defect: the
  slot-assignment consumer shared the vetting consumer group (`application-service`)
  with a divergent topic subscription, so the group rebalanced perpetually — in
  production too. Fixed by giving the slot projection its own group
  (`application-service-slot`). The proof is now deterministic (10/10, ~14s; 0
  rebalances) and the gate is 17/17. See
  [pipeline-convergence-fix.md](./pipeline-convergence-fix.md).
- `NO_VENUE` applications are not auto-rescheduled when a venue is later seeded
  (the `application.cleared` event already committed). Manual re-drive for now.
- Downstream stages (`PHYSICAL_TEST_SCHEDULED` and beyond), `DOCUMENT_REVIEW_AMBER`
  manual-review lane, signed/verifiable QR — all still open.
- Late disqualification (a hard-fail verdict after a slot is assigned) currently
  auto-rejects a scheduled applicant off the backbone. Whether that should instead
  route to human adjudication is an **owner/agency policy decision** (flagged in
  `lifecycle.ts`, not silently settled).
