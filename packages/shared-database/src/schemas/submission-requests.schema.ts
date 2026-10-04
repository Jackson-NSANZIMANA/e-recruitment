import { pgSchema, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { agencyEnum } from './public-core.schema.js';

// Declared against its own handle rather than importing `publicCore`, for the
// same reason slot-reservations.schema.ts exists as its own file: one ledger
// per file keeps the rls/00NN ↔ mirror correspondence one-to-one and readable.
const publicCore = pgSchema('public_core');

/**
 * Submission request ledger (ADR-027): the front door's idempotency record.
 *
 * One row per ACCEPTED submission request, written in the SAME transaction
 * that inserts the application, its opening history row and the
 * APPLICANT_SUBMITTED outbox entry. The primary key is the pair the client
 * controls — `(applicant_id, idempotency_key)` — which is what makes a retry
 * replayable: the second request finds the first one's row and returns the
 * application it already created instead of filing a second one.
 *
 * `request_hash` is the canonical SHA-256 of the submission's business content
 * (see services/application-service/src/domain/request-hash.ts). It is what
 * separates an honest retry from a reused key: same key + same hash ⇒ replay;
 * same key + different hash ⇒ KEY_REUSED, and nothing is written.
 *
 * `application_id` carries a UNIQUE constraint
 * (`submission_requests_application_unique`) so one application can never be
 * claimed by two different request keys.
 *
 * Deliberately NO foreign keys: applications live in three isolated agency
 * schemas (rdf_ops / rnp_ops / rcs_ops), and the ledger is the record that a
 * request *was accepted* — it must outlive any one schema's row.
 *
 * Grants (SELECT + INSERT only — UPDATE/DELETE/TRUNCATE revoked) and FORCE'd
 * RLS are applied by rls/0022_submission_integrity.sql, the system of record.
 */
export const submissionRequests = publicCore.table(
  'submission_requests',
  {
    applicantId: uuid('applicant_id').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    agency: agencyEnum('agency').notNull(),
    applicationId: uuid('application_id').notNull(),
    processingCode: text('processing_code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.applicantId, t.idempotencyKey] }),
    unique('submission_requests_application_unique').on(t.applicationId),
  ],
);
