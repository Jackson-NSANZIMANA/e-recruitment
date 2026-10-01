// ══════════════════════════════════════════════════════════════════
// application-service — Event outbox ports (ADR-025)
//
// Two seams, deliberately separate:
//
//   StageEvents      — handed to a repository write. Invoked INSIDE the
//                      writing transaction, after every state write, with the
//                      outcome. Whatever it returns is persisted in the SAME
//                      transaction, so the state change and the events that
//                      announce it commit together or not at all.
//
//   EventDispatcher  — called by the use case AFTER commit with those same
//                      events. Best-effort fast path: it never throws for a
//                      transport fault, because the events are already
//                      durable and the relay owns delivery.
//
// A StageEvents callback must be PURE (no I/O, no clock, no randomness): mint
// envelopes before the write, so the staged event and the dispatched one are
// the same event with the same eventId.
// ══════════════════════════════════════════════════════════════════

import type { USRPEvent } from '@usrp/shared-types';

/** Events a state change must announce, derived from that change. */
export type StageEvents<TOutcome> = (outcome: TOutcome) => readonly USRPEvent[];

/** Post-commit dispatch of events that are already durable in the outbox. */
export interface EventDispatcher {
  dispatch(events: readonly USRPEvent[]): Promise<void>;
}
