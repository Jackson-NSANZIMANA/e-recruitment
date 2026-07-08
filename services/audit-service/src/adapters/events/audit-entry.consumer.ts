// ══════════════════════════════════════════════════════════════════
// audit-service — AUDIT_ENTRY consumer (the only ingress)
//
// The audit-service has no HTTP write surface: the trail is written ONLY off
// the event backbone, never by a synchronous caller. That is the integrity
// guarantee — no service can be tricked into forging an entry via an API; it
// can only emit an event, which is itself captured verbatim.
//
// Subscribes the consumer group `audit-service` to `audit.immutable`. Every
// producer in the platform (identity, eligibility age + NESA, and every
// future one) writes here; this single sink durably records them all.
// ══════════════════════════════════════════════════════════════════

import { KAFKA_TOPICS } from '@usrp/shared-types';
import type { EventBus, EventHandler } from '@usrp/shared-events';
import type { AuditWriter } from '../../ports/audit-writer.js';
import { toAuditRecord } from '../../application/audit-event.mapper.js';

export const AUDIT_CONSUMER_GROUP = 'audit-service';

/**
 * Wire the audit sink to the immutable topic. On each AUDIT_ENTRY: map →
 * append (idempotently). A write failure PROPAGATES so the bus does not
 * commit the offset and the event is redelivered — losing a forensic record
 * is unacceptable; re-appending a duplicate is harmless (idempotent).
 */
export async function startAuditEntryConsumer(
  eventBus: EventBus,
  writer: AuditWriter,
): Promise<void> {
  const handler: EventHandler = async (event) => {
    // Topic is single-type, but stay defensive against mis-routing.
    if (event.eventType !== 'AUDIT_ENTRY') return;

    const outcome = await writer.append(toAuditRecord(event));

    console.log(
      JSON.stringify({
        msg: 'audit_entry_recorded',
        outcome, // 'inserted' | 'duplicate'
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        agency: event.agency,
        correlationId: event.correlationId,
        kafkaEventId: event.eventId,
      }),
    );
  };

  await eventBus.subscribe([KAFKA_TOPICS.AUDIT_IMMUTABLE], AUDIT_CONSUMER_GROUP, handler);
}
