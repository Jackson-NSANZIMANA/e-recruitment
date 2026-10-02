// ══════════════════════════════════════════════════════════════════
// scheduling-service — Slot ledger + event dispatch ports (ADR-026)
//
// The ledger is the scheduling decision of record: at most one reservation
// per application, a seat counted against the venue in the same transaction,
// and the SLOT_ASSIGNED that announced it kept verbatim. It is what lets the
// gate answer a redelivered clearance with the SAME invitation instead of a
// second one.
//
// Same seam shape as application-service (ADR-025): a write accepts a PURE
// StageEvents callback, invoked inside the transaction with the outcome, whose
// events are staged in the outbox before COMMIT. The EventDispatcher then
// publishes those same events after commit, best-effort.
// ══════════════════════════════════════════════════════════════════

import type { Agency, SlotAssignedEvent, USRPEvent } from '@usrp/shared-types';

export interface ReserveSlotInput {
  readonly applicationId: string;
  readonly agency: Agency;
  readonly campaignId: string;
  readonly venueAssignmentId: string;
  /** The fully built, signed announcement. Stored verbatim on success. */
  readonly slotEvent: SlotAssignedEvent;
}

export type NoCapacityReason = 'VENUE_AT_CAPACITY' | 'VENUE_INACTIVE';

export type ReserveSlotOutcome =
  /** Seat counted, reservation written, the caller's events staged. */
  | { readonly kind: 'RESERVED' }
  /** A reservation already exists; `event` is what was announced then. */
  | { readonly kind: 'ALREADY_ASSIGNED'; readonly event: SlotAssignedEvent }
  /** No seat: nothing reserved, only the caller's deferral events staged. */
  | {
      readonly kind: 'NO_CAPACITY';
      readonly reason: NoCapacityReason;
      readonly capacityLimit: number | null;
      readonly registeredCount: number | null;
    };

/** Events a ledger write must announce, derived from its outcome. MUST be pure. */
export type StageEvents<TOutcome> = (outcome: TOutcome) => readonly USRPEvent[];

export interface SlotLedger {
  /** The SLOT_ASSIGNED already announced for this application, or null. */
  findReservation(applicationId: string): Promise<SlotAssignedEvent | null>;
  /** Atomically: count a seat, record the reservation, stage `stage(outcome)`. */
  reserve(input: ReserveSlotInput, stage: StageEvents<ReserveSlotOutcome>): Promise<ReserveSlotOutcome>;
  /** Stage events that announce a decision with no state of its own (a deferral). */
  recordDeferral(events: readonly USRPEvent[]): Promise<void>;
}

/** Post-commit dispatch of events that are already durable in the outbox. */
export interface EventDispatcher {
  dispatch(events: readonly USRPEvent[]): Promise<void>;
}
