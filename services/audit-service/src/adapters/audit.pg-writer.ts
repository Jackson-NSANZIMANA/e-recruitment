// ══════════════════════════════════════════════════════════════════
// audit-service — PgAuditWriter adapter (PostgreSQL, append-only)
//
// Writes to audit_log.audit_entries as the `usrp_audit_writer` role: the app
// connects as the privilege-less `usrp_app` login and SET LOCAL ROLEs per
// transaction — the same idiom every other service uses (identity repository,
// eligibility reader). The writer role holds INSERT+SELECT only; UPDATE and
// DELETE are refused by both grant-omission and the 0002 immutability trigger.
//
// Idempotency: delivery is at-least-once, so the same AUDIT_ENTRY may arrive
// twice. `kafka_event_id` is UNIQUE; `ON CONFLICT DO NOTHING` makes a repeat
// a no-op that returns 'duplicate'. We never UPDATE on conflict — that would
// be a mutation of the immutable trail (and the trigger would reject it).
// ══════════════════════════════════════════════════════════════════

import { sql, asJsonb } from '@usrp/shared-database';
import type { AppendOutcome, AuditRecord, AuditWriter } from '../ports/audit-writer.js';
import { AuditWriteError } from '../domain/audit.errors.js';

const AUDIT_WRITER_ROLE = 'usrp_audit_writer';

export class PgAuditWriter implements AuditWriter {
  async append(record: AuditRecord): Promise<AppendOutcome> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(AUDIT_WRITER_ROLE)}`;

        // RETURNING yields the row only when a row was actually inserted;
        // ON CONFLICT DO NOTHING suppresses the RETURNING for a duplicate.
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO audit_log.audit_entries (
            kafka_event_id, correlation_id, causation_id,
            entity_type, entity_id, agency, action,
            performed_by, performed_by_role,
            previous_status, new_status,
            ip_address, user_agent,
            metadata, occurred_at
          ) VALUES (
            ${record.kafkaEventId}, ${record.correlationId}, ${record.causationId},
            ${record.entityType}, ${record.entityId}, ${record.agency}, ${record.action},
            ${record.performedBy}, ${record.performedByRole},
            ${record.previousStatus}, ${record.newStatus},
            ${record.ipAddress}, ${record.userAgent},
            ${tx.json(asJsonb(record.metadata ?? null))}, ${record.occurredAt}
          )
          ON CONFLICT (kafka_event_id) DO NOTHING
          RETURNING id
        `;

        return inserted.length > 0 ? 'inserted' : 'duplicate';
      });
    } catch (cause) {
      throw new AuditWriteError('Failed to append audit record', { cause });
    }
  }
}
