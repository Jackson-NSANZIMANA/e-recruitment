// ══════════════════════════════════════════════════════════════════
// scheduling-service — PgSlotLedger (PostgreSQL, ADR-026)
//
// reserve() is ONE transaction as usrp_system_service:
//
//   1. Existing reservation?  → ALREADY_ASSIGNED with the stored event.
//   2. Conditional seat increment on the venue row:
//        UPDATE … SET registered_count = registered_count + 1
//        WHERE id = $venue AND is_active
//          AND (capacity_limit IS NULL OR registered_count < capacity_limit)
//      The UPDATE takes the venue row lock, so every reservation for one
//      venue serialises here and the count can never overshoot. 0 rows →
//      re-check for a reservation that committed while we waited (a
//      concurrent duplicate may have taken the LAST seat), else NO_CAPACITY.
//   3. INSERT the reservation, ON CONFLICT (application_id) DO NOTHING. A
//      conflict means a concurrent delivery of the same clearance won; we
//      still hold the venue row lock, so decrementing restores the exact
//      count. Then ALREADY_ASSIGNED with the winner's event.
//   4. Stage the caller's events in the outbox. Last, so nothing after it
//      can fail and leave an announcement for a rolled-back reservation.
//
// Infrastructure faults throw SchedulingWriteError: the consumer lets it
// propagate, the bus retries with backoff, then dead-letters (ADR-025).
// ══════════════════════════════════════════════════════════════════

import { asJsonb, sql, stageOutboxEvents, type SqlTransaction } from '@usrp/shared-database';
import { hasValidEnvelope } from '@usrp/shared-events';
import type { SlotAssignedEvent, USRPEvent } from '@usrp/shared-types';
import type {
  ReserveSlotInput,
  ReserveSlotOutcome,
  SlotLedger,
  StageEvents,
} from '../ports/slot-ledger.js';
import { SchedulingReadError, SchedulingWriteError } from '../domain/scheduling.errors.js';

const SYSTEM_ROLE = 'usrp_system_service';

/** This service's outbox rows. Its relay drains only these. */
export const SCHEDULING_OUTBOX_PRODUCER = 'scheduling-service';

/** A stored payload must still be the SLOT_ASSIGNED it was written as. */
function decodeSlotEvent(payload: unknown): SlotAssignedEvent {
  if (!hasValidEnvelope(payload) || payload.eventType !== 'SLOT_ASSIGNED') {
    // Only reachable by manual edit or corruption. Fail loudly: re-announcing
    // a malformed invitation would be worse than not announcing one.
    throw new SchedulingReadError('slot_reservations.slot_event is not a valid SLOT_ASSIGNED event');
  }
  return payload as unknown as SlotAssignedEvent;
}

async function reservationIn(tx: SqlTransaction, applicationId: string): Promise<SlotAssignedEvent | null> {
  const rows = await tx<{ slot_event: unknown }[]>`
    SELECT slot_event FROM public_core.slot_reservations WHERE application_id = ${applicationId}
  `;
  const row = rows[0];
  return row === undefined ? null : decodeSlotEvent(row.slot_event);
}

export class PgSlotLedger implements SlotLedger {
  async findReservation(applicationId: string): Promise<SlotAssignedEvent | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        return await reservationIn(tx, applicationId);
      });
    } catch (cause) {
      if (cause instanceof SchedulingReadError) throw cause;
      throw new SchedulingReadError('Failed to read slot reservation', { cause });
    }
  }

  async reserve(
    input: ReserveSlotInput,
    stage: StageEvents<ReserveSlotOutcome>,
  ): Promise<ReserveSlotOutcome> {
    try {
      return await sql.begin(async (tx): Promise<ReserveSlotOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        // 1. Already decided: answer with the decision of record.
        const prior = await reservationIn(tx, input.applicationId);
        if (prior !== null) return { kind: 'ALREADY_ASSIGNED', event: prior };

        // 2. Count a seat, under the venue row lock.
        const seat = await tx<{ registered_count: number }[]>`
          UPDATE public_core.campaign_venue_assignments
          SET registered_count = registered_count + 1
          WHERE id = ${input.venueAssignmentId}
            AND is_active = true
            AND (capacity_limit IS NULL OR registered_count < capacity_limit)
          RETURNING registered_count
        `;

        if (seat[0] === undefined) {
          // A concurrent delivery of THIS clearance may have committed while we
          // waited on the row lock and taken the last seat. That is not "full"
          // for this application, it is already assigned.
          const raced = await reservationIn(tx, input.applicationId);
          if (raced !== null) return { kind: 'ALREADY_ASSIGNED', event: raced };

          const venueRows = await tx<
            { capacity_limit: number | null; registered_count: number; is_active: boolean }[]
          >`
            SELECT capacity_limit, registered_count, is_active
            FROM public_core.campaign_venue_assignments
            WHERE id = ${input.venueAssignmentId}
          `;
          const venue = venueRows[0];
          const full: ReserveSlotOutcome = {
            kind: 'NO_CAPACITY',
            reason: venue !== undefined && venue.is_active ? 'VENUE_AT_CAPACITY' : 'VENUE_INACTIVE',
            capacityLimit: venue?.capacity_limit ?? null,
            registeredCount: venue?.registered_count ?? null,
          };
          await stageOutboxEvents(tx, stage(full), SCHEDULING_OUTBOX_PRODUCER);
          return full;
        }

        // 3. Record the decision.
        const inserted = await tx<{ application_id: string }[]>`
          INSERT INTO public_core.slot_reservations
            (application_id, agency, campaign_id, venue_assignment_id, slot_event_id, slot_event)
          VALUES (
            ${input.applicationId},
            ${input.agency}::public_core.agency,
            ${input.campaignId},
            ${input.venueAssignmentId},
            ${input.slotEvent.eventId},
            ${tx.json(asJsonb(input.slotEvent))}
          )
          ON CONFLICT (application_id) DO NOTHING
          RETURNING application_id
        `;

        if (inserted[0] === undefined) {
          // Lost the race to a concurrent delivery of the same clearance. We
          // still hold the venue row lock, so this restores the exact count.
          await tx`
            UPDATE public_core.campaign_venue_assignments
            SET registered_count = registered_count - 1
            WHERE id = ${input.venueAssignmentId}
          `;
          const winner = await reservationIn(tx, input.applicationId);
          if (winner === null) {
            throw new SchedulingWriteError('reservation conflict reported but no winning reservation is visible');
          }
          return { kind: 'ALREADY_ASSIGNED', event: winner };
        }

        // 4. The announcement commits WITH the reservation, or neither does.
        const reserved: ReserveSlotOutcome = { kind: 'RESERVED' };
        await stageOutboxEvents(tx, stage(reserved), SCHEDULING_OUTBOX_PRODUCER);
        return reserved;
      });
    } catch (cause) {
      if (cause instanceof SchedulingReadError || cause instanceof SchedulingWriteError) throw cause;
      throw new SchedulingWriteError('Failed to reserve exam slot', { cause });
    }
  }

  async recordDeferral(events: readonly USRPEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        await stageOutboxEvents(tx, events, SCHEDULING_OUTBOX_PRODUCER);
      });
    } catch (cause) {
      throw new SchedulingWriteError('Failed to record slot deferral', { cause });
    }
  }
}
