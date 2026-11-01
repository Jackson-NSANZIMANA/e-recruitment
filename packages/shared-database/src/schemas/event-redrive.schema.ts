// ══════════════════════════════════════════════════════════════════
// @usrp/shared-database — event_redrive_ledger model (D2, rls/0045)
//
// Mirrors public_core.event_redrive_ledger. The ledger is the SCHEDULE for
// dead letters (ADR-050): a Kafka offset is a cursor and cannot be asked "who
// is due at 03:00". No payload column, deliberately — the bytes stay on
// events.dead-letter, and this table only records WHEN and WHETHER.
// ══════════════════════════════════════════════════════════════════

import { bigint, index, integer, primaryKey, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { publicCore } from './public-core.schema.js';

export const eventRedriveLedger = publicCore.table(
  'event_redrive_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceTopic: varchar('source_topic', { length: 128 }).notNull(),
    sourcePartition: integer('source_partition').notNull(),
    /** Kafka offsets are 64-bit: bigint mode 'bigint' keeps them exact. */
    sourceOffset: bigint('source_offset', { mode: 'bigint' }).notNull(),
    groupId: varchar('group_id', { length: 128 }).notNull(),
    /** x-usrp-dlq-event-id: lets a returning event inherit the attempts already spent. */
    eventId: varchar('event_id', { length: 64 }),
    /** The ADR-025 reason the letter arrived with. */
    reason: varchar('reason', { length: 24 }).notNull(),
    attempts: integer('attempts').default(0).notNull(),
    consecutiveGroupFailures: integer('consecutive_group_failures').default(0).notNull(),
    state: varchar('state', { length: 16 }).default('RETRYING').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    lastErrorCode: varchar('last_error_code', { length: 48 }),
    parkedReason: varchar('parked_reason', { length: 32 }),
    parkedAt: timestamp('parked_at', { withTimezone: true }),
  },
  (t) => [
    unique('uq_event_redrive_letter').on(t.sourceTopic, t.sourcePartition, t.sourceOffset, t.groupId),
    index('idx_event_redrive_due').on(t.nextAttemptAt),
    index('idx_event_redrive_group').on(t.groupId, t.sourceTopic, t.state),
    index('idx_event_redrive_chain').on(t.groupId, t.eventId),
  ],
);

/** How far into each dead-letter partition the worker has REGISTERED letters (rls/0045). */
export const eventRedriveCursor = publicCore.table(
  'event_redrive_cursor',
  {
    topic: varchar('topic', { length: 128 }).notNull(),
    partition: integer('partition').notNull(),
    nextOffset: bigint('next_offset', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.topic, t.partition] })],
);
