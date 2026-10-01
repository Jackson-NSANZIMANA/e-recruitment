import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgSchema,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const publicCore = pgSchema('public_core');

/**
 * Transactional event outbox (ADR-025). A row is staged in the SAME
 * transaction as the state change it announces and published by the owning
 * service's relay. Grants and FORCE'd RLS are applied by rls/0020_event_outbox.sql.
 */
export const eventOutbox = publicCore.table(
  'event_outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    eventId: uuid('event_id').notNull().unique(),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    producer: varchar('producer', { length: 64 }).notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: varchar('last_error', { length: 512 }),
  },
  (t) => [
    index('idx_pc_event_outbox_pending')
      .on(t.producer, t.id)
      .where(sql`published_at IS NULL`),
    index('idx_pc_event_outbox_published')
      .on(t.publishedAt)
      .where(sql`published_at IS NOT NULL`),
  ],
);
