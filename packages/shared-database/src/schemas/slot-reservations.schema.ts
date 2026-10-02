import { index, jsonb, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agencyEnum, publicCore } from './public-core.schema.js';

/**
 * Slot reservation ledger (ADR-026): the scheduling decision of record. One
 * row per application, written in the same transaction that advances the
 * venue's registered_count and stages SLOT_ASSIGNED in the outbox. slot_event
 * is that SLOT_ASSIGNED verbatim, so a redelivered clearance re-announces the
 * SAME ticket instead of minting a second one.
 *
 * Grants (SELECT + INSERT only), FORCE'd RLS and the two venue CHECKs are
 * applied by rls/0021_slot_reservations.sql, the system of record.
 */
export const slotReservations = publicCore.table(
  'slot_reservations',
  {
    applicationId: uuid('application_id').primaryKey(),
    agency: agencyEnum('agency').notNull(),
    campaignId: uuid('campaign_id').notNull(),
    venueAssignmentId: uuid('venue_assignment_id').notNull(),
    slotEventId: uuid('slot_event_id').notNull().unique(),
    slotEvent: jsonb('slot_event').notNull(),
    reservedAt: timestamp('reserved_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_pc_slot_reservations_venue').on(t.venueAssignmentId),
    index('idx_pc_slot_reservations_campaign').on(t.campaignId),
  ],
);
