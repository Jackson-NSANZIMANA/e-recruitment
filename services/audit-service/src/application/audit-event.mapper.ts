// ══════════════════════════════════════════════════════════════════
// audit-service — AuditEvent → AuditRecord mapping (pure)
//
// Translates the wire event (its envelope + audit fields) into the persistence
// record. Pure and total: no I/O, no throwing on well-typed input. Kept
// separate from the adapter so the field mapping is unit-verifiable on its own.
//
// The DB entity_type enum is a SUPERSET of the event's ('DOCUMENT', 'VENUE'
// exist in the DB but not the event union) — passing the event value through
// is always valid. The reverse tightening (reconciling the two enums) is a
// shared-types concern, deliberately out of scope for this sink slice.
// ══════════════════════════════════════════════════════════════════

import type { AuditEvent } from '@usrp/shared-types';
import type { AuditRecord } from '../ports/audit-writer.js';

/**
 * Build the immutable audit record from an AUDIT_ENTRY event.
 * `causationId` is required on the envelope but may be an empty string for a
 * root event; we normalise "" → null so the DB column reflects "no cause".
 * Optional event fields (exactOptionalPropertyTypes) become explicit nulls.
 */
export function toAuditRecord(event: AuditEvent): AuditRecord {
  return {
    kafkaEventId: event.eventId,
    correlationId: event.correlationId,
    causationId: event.causationId ? event.causationId : null,

    entityType: event.entityType,
    entityId: event.entityId,
    agency: event.agency,
    action: event.action,

    performedBy: event.performedBy,
    // The event union carries no role today; the column exists for officer
    // actions once officer-performed events land. Null until then.
    performedByRole: null,

    previousStatus: event.previousStatus ?? null,
    newStatus: event.newStatus ?? null,

    ipAddress: event.ipAddress ?? null,
    // No userAgent on the event contract yet; column reserved for HTTP-origin
    // audit once ingress-level auditing is added.
    userAgent: null,

    metadata: event.metadata ?? null,

    occurredAt: event.occurredAt,
  };
}
