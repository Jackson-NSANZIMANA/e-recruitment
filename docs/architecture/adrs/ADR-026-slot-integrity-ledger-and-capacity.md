# ADR-026 — Slot integrity: one invitation per application, enforced venue capacity

**Status:** accepted (wave 3 of the P0 hardening programme)
**Date:** 2026-10-01
**Extends:** ADR-008 (scheduling gate), ADR-009 (signed QR), ADR-025 (outbox)
**Depends on:** wave 1 (#14, ticket-bound scores) and wave 2 (#15, outbox)

## Context: wave 2 made a latent defect live

ADR-025 made `APPLICATION_ELIGIBILITY_CLEARED` **at-least-once on purpose**:
the relay republishes after a crash between publish and stamp, and the fast
path and relay can both publish a row. That is correct, and it lands on a
consumer that could not survive it.

`scheduling-service` kept **no state**. For every CLEARED it received it:

1. minted a fresh random ticket (`qrInvitationCode`),
2. signed a fresh QR credential over it,
3. published `SLOT_ASSIGNED`, then `AUDIT_ENTRY`.

Trace a single redelivery through the code as it stood:

| Step | Code | Effect |
|---|---|---|
| CLEARED #1 | `AssignSlotService.assign` | ticket **A**, SLOT_ASSIGNED(A) |
| | `applySlotAssignment` | row stamped with **A**, status SLOT_ASSIGNED |
| | `DeliverInvitationService.deliver` | SMS with **A** |
| CLEARED #2 (redelivery) | `AssignSlotService.assign` | ticket **B**, SLOT_ASSIGNED(B) |
| | `applySlotAssignment` | `status === 'SLOT_ASSIGNED'` ⇒ **NO_CHANGE**, row keeps **A** |
| | `DeliverInvitationService.deliver` | **SMS with B**, no dedupe |
| Exam day | field-sync (wave 1) | score bound to the row's ticket: **B ⇒ TICKET_MISMATCH** |

The citizen holds two invitations, the newest one is the one that does not
work, and nothing anywhere is red.

The same review found a second, independent gap. `campaign_venue_assignments`
has carried `capacity_limit` and `registered_count` since the genesis
migration. **Nothing reads the first or writes the second.** ADR-008 said "no
capacity this slice"; the columns made it look done. Every venue was
unbounded.

And a third, smaller one: scheduling published `SLOT_ASSIGNED` and then
`AUDIT_ENTRY` with nothing between them. A crash in between lost the audit; a
broker refusal threw, the bus retried, and the retry minted a new ticket.

## Decision

### 1. A slot ledger: the decision of record (`rls/0021`)

`public_core.slot_reservations`, one row per application (PK
`application_id`), keeping the announced `SLOT_ASSIGNED` **verbatim** in
`slot_event`. Append-only for its writer (`SELECT, INSERT` to
`usrp_system_service`; `UPDATE/DELETE/TRUNCATE` revoked), FORCE'd RLS.

No foreign keys, deliberately: the row is the record that an invitation *was
issued* and must outlive venue reference-data churn (venues are deactivated,
not deleted), and applications live in three agency schemas.

### 2. Redelivery re-announces; it never re-decides

`assign()` checks the ledger **first**. A reservation exists ⇒ dispatch the
stored event (same `eventId`, ticket and signed token) and return
`ALREADY_ASSIGNED`. No PII decrypted, nothing minted.

Re-announcing (rather than staying silent) is what keeps at-least-once honest
downstream: a consumer that missed the original still converges, on the
**same** ticket. The pipeline proof's CLEARED nudges depend on exactly this.

### 3. Seats are counted under the venue row lock

`PgSlotLedger.reserve` is one transaction:

1. existing reservation ⇒ `ALREADY_ASSIGNED`;
2. `UPDATE campaign_venue_assignments SET registered_count = registered_count + 1
   WHERE id = $venue AND is_active AND (capacity_limit IS NULL OR registered_count < capacity_limit)`;
   the row lock serialises every reservation for one venue, so the count
   cannot overshoot. 0 rows ⇒ re-check the ledger (a concurrent duplicate may
   have taken the last seat), else `NO_CAPACITY`;
3. `INSERT … ON CONFLICT (application_id) DO NOTHING`; a conflict means a
   concurrent duplicate won, so give the seat back (we still hold the lock)
   and return the winner's event;
4. stage `SLOT_ASSIGNED` + `AUDIT_ENTRY` in the outbox. Last.

`usrp_system_service` gains `UPDATE (registered_count)` only: a column grant.
Two CHECKs make a negative count and a non-positive capacity unrepresentable.
`NULL` capacity still means unbounded, so every existing seed behaves exactly
as before.

### 4. Scheduling joins the outbox, and the outbox moves to a shared home

Scheduling is the outbox's second adopter, which is the moment ADR-025 named
for lifting it. It now lives in `@usrp/shared-database` (`outbox.ts`),
**structurally typed** (`{ eventId, eventType }` and a one-method publisher)
so the package gains no dependency on `@usrp/shared-events` and
`pnpm-lock.yaml` is untouched. application-service keeps its exported surface
through a thin binding; scheduling starts its own relay (producer
`scheduling-service`) in `main.ts`.

Deferrals (`NO_VENUE`, `NO_CAPACITY`) are staged too: an audit that a citizen
was *not* scheduled is exactly the record an appeal needs.

## Consequences

- **One invitation per application**, under redelivery, concurrent delivery
  (rebalance) and broker outage. Proven by
  `services/scheduling-service/selfcheck/verify-slot-integrity.ts`.
- **No venue is overbooked**: capacity 2 with 5 concurrent applicants gives
  exactly 2 assignments, 3 `VENUE_AT_CAPACITY` deferrals and a count of 2.
- **A full venue holds the application at `DOCUMENT_REVIEW_GREEN`** with an
  audited reason, the same honest hold as `NO_VENUE`. There is still no
  automatic re-drive (ADR-008's known limitation, now with two causes).
- **The ledger stores the signed token.** It is the same bearer material
  already present in `slot.assigned` (7-day retention), the outbox payload
  (7-day purge) and `applications.qr_invitation_code`. Unlike those, the
  ledger is permanent. Erasure (ADR-015) must therefore include
  `slot_reservations`; that is a **DPO decision** and is listed below.
- **Existing deployments**: `registered_count` was never written, so it is 0
  everywhere. That is correct today because no venue has a capacity. Before
  setting `capacity_limit` on a live campaign, reconcile:
  ```sql
  UPDATE public_core.campaign_venue_assignments v
  SET registered_count = (SELECT count(*) FROM public_core.slot_reservations r
                          WHERE r.venue_assignment_id = v.id)
  WHERE v.campaign_id = $1;
  ```

## Corrections to the record

- ADR-025 and PR #15 say "the audit sink can append a duplicate row on
  redelivery; a processed-event ledger is the follow-up." **That is not what
  the code does.** `audit_log.audit_entries.kafka_event_id` is UNIQUE and
  `PgAuditWriter.append` uses `ON CONFLICT (kafka_event_id) DO NOTHING`. A
  redelivered event (same `eventId`) is already a no-op. The real duplicate
  risk is a *producer* minting a new envelope for the same fact, which is
  precisely what scheduling did and this ADR stops. The processed-event
  ledger is therefore **not** needed for audit; the first genuine candidate is
  notification-service (one SMS per `SLOT_ASSIGNED` delivery).

## Not done here

1. **Seat release on withdrawal / rejection after assignment.** Seats are
   counted and never returned. Needs a `released_at` column, its own grant,
   and a consumer of the withdrawal/rejection events. Until then, a venue's
   effective capacity shrinks with every post-slot withdrawal.
2. **Re-drive for deferred applications** (`NO_VENUE`, `NO_CAPACITY`): an
   operator command that re-emits CLEARED for GREEN rows without a
   reservation.
3. **Notification dedupe**: one invitation SMS per application (keyed on the
   reservation's `slot_event_id`), so an at-least-once re-announcement does
   not text the citizen twice. Same ticket, so it is noise, not breakage.
4. **Erasure**: add `slot_reservations` to the ADR-015 erasure road (DPO).
