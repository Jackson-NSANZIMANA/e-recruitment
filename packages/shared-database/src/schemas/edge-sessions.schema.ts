import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgSchema,
  timestamp,
  text,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { agencyEnum } from './public-core.schema.js';

const publicCore = pgSchema('public_core');

/**
 * Durable browser-boundary sessions. The upstream credential is an encrypted
 * envelope, never a browser value; handle and CSRF values are keyed hashes.
 * RLS/grants are applied by rls/0019_edge_sessions.sql.
 */
export const edgeSessions = publicCore.table(
  'edge_sessions',
  {
    sessionId: uuid('session_id').defaultRandom().primaryKey(),
    handleHash: varchar('handle_hash', { length: 64 }).notNull().unique(),
    previousHandleHash: varchar('previous_handle_hash', { length: 64 }),
    previousCsrfTokenHash: varchar('previous_csrf_token_hash', { length: 64 }),
    previousValidUntil: timestamp('previous_valid_until', { withTimezone: true }),
    csrfTokenHash: varchar('csrf_token_hash', { length: 64 }).notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    subjectId: uuid('subject_id'),
    agency: agencyEnum('agency'),
    roles: text('roles').array().notNull().default([]),
    upstreamCredential: text('upstream_credential').notNull(),
    upstreamExpiresAt: timestamp('upstream_expires_at', { withTimezone: true }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: varchar('revoked_reason', { length: 32 }),
  },
  (t) => [
    index('idx_pc_edge_sessions_prev_handle')
      .on(t.previousHandleHash)
      .where(sql`previous_handle_hash IS NOT NULL`),
    index('idx_pc_edge_sessions_absolute').on(t.absoluteExpiresAt),
    check(
      'edge_sessions_officer_shape',
      sql`(kind = 'officer' AND agency IS NOT NULL AND subject_id IS NOT NULL) OR (kind = 'applicant' AND agency IS NULL)`,
    ),
    check('edge_sessions_ttl_order', sql`absolute_expires_at >= idle_expires_at`),
  ],
);
