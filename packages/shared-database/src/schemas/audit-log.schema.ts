// ══════════════════════════════════════════════════════════════════
// audit_log schema — Immutable government audit trail
// CRITICAL: No UPDATE or DELETE ever permitted on these tables
// Enforced at database role level (REVOKE UPDATE, DELETE)
// Every significant system action produces an audit_entry row
// ══════════════════════════════════════════════════════════════════

import {
  pgSchema,
  uuid,
  varchar,
  timestamp,
  pgEnum,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const auditLog = pgSchema('audit_log');

export const auditEntityTypeEnum = auditLog.enum('entity_type', [
  'APPLICANT',
  'APPLICATION',
  'DOCUMENT',
  'OFFICER',
  'CAMPAIGN',
  'VENUE',
  'SYSTEM',
]);

export const auditAgencyEnum = auditLog.enum('agency', [
  'RDF', 'RNP', 'RCS', 'SYSTEM',
]);

// ── audit_log.audit_entries ───────────────────────────────────────
// The permanent, immutable government record of all system actions.
// This table is the forensic ground truth for any dispute or investigation.
// Written by the audit-service Kafka consumer.
// No application code has UPDATE or DELETE permission on this table.

export const auditEntries = auditLog.table(
  'audit_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Kafka event tracing
    kafkaEventId: varchar('kafka_event_id', { length: 128 }).notNull().unique(),
    correlationId: varchar('correlation_id', { length: 128 }).notNull(),
    causationId: varchar('causation_id', { length: 128 }),

    // What entity was affected
    entityType: auditEntityTypeEnum('entity_type').notNull(),
    entityId: varchar('entity_id', { length: 128 }).notNull(),
    agency: auditAgencyEnum('agency').notNull(),

    // What happened
    action: varchar('action', { length: 100 }).notNull(),
    // e.g. 'APPLICATION_SUBMITTED', 'STATUS_CHANGED', 'DOCUMENT_UPLOADED',
    //      'NIDA_VERIFICATION_COMPLETED', 'OFFICER_APPROVED_DOCUMENT'

    // Who did it
    performedBy: varchar('performed_by', { length: 128 }).notNull(),
    // 'SYSTEM' for automated actions, officer UUID for manual actions
    performedByRole: varchar('performed_by_role', { length: 50 }),

    // Status transition (when applicable)
    previousStatus: varchar('previous_status', { length: 50 }),
    newStatus: varchar('new_status', { length: 50 }),

    // Security context
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: varchar('user_agent', { length: 512 }),

    // Additional context — flexible JSON for event-specific metadata
    // Never contains PII — only references (IDs, hashes, status codes)
    metadata: jsonb('metadata'),

    // When it happened — source of truth is Kafka event timestamp
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    // When it was written to this table (may differ slightly from occurredAt)
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_audit_entity').on(t.entityType, t.entityId),
    index('idx_audit_agency').on(t.agency),
    index('idx_audit_action').on(t.action),
    index('idx_audit_performed_by').on(t.performedBy),
    index('idx_audit_occurred_at').on(t.occurredAt),
    index('idx_audit_correlation').on(t.correlationId),
  ],
);
