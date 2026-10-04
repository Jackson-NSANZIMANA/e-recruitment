// ══════════════════════════════════════════════════════════════════
// application-service — Front-door INSERT primitives (shared, ADR-027)
//
// TWO adapters now file an application through the front door:
//
//   PgApplicationRepository.createApplication — the direct write, still used
//     by proof fixtures and by callers that bring their own idempotency.
//   PgSubmissionLedger.recordSubmission       — the idempotent write, which
//     additionally records the request in public_core.submission_requests.
//
// Both must produce an IDENTICAL row: same processing-code minting, same
// column set, same opening history entry. Keeping two copies of that SQL in
// two adapters is precisely the drift that this slice exists to stop, so the
// statements live here once and both adapters call them inside their own
// transaction.
//
// Nothing here opens a transaction or sets a role: the caller owns both, so
// these compose into whatever atomic unit the caller needs.
// ══════════════════════════════════════════════════════════════════

import { sql, type SqlTransaction } from '@usrp/shared-database';
import type { ApplicationCategory } from '@usrp/shared-types';
import type { AgencyTarget } from '../domain/agency-schema.js';
import type { CreateApplicationResult } from '../ports/application-repository.js';
import { ApplicationPersistenceError } from '../domain/application.errors.js';

/** The columns the front door sets on a brand-new SUBMITTED application. */
export interface FrontDoorApplicationRow {
  readonly applicantId: string;
  readonly campaignId: string;
  readonly category: ApplicationCategory;
  readonly nesaIndexNumber: string | null;
  readonly hecRegistrationNumber: string | null;
}

/**
 * Mint the next per-agency processing code (`RDF-00042`).
 *
 * `nextval` is contention-free and NOT rolled back, so concurrent submissions
 * can never collide on a code. A rolled-back transaction burns its number —
 * which is the correct trade: a gap in the sequence is harmless, a reused
 * processing code is not.
 */
export async function mintProcessingCode(
  tx: SqlTransaction,
  target: AgencyTarget,
): Promise<string> {
  const seqName = `${target.schema}.processing_code_seq`;
  const rows = await tx<{ code: string }[]>`
    SELECT ${target.codePrefix} || '-' || lpad(nextval(${seqName}::regclass)::text, 5, '0') AS code
  `;
  const code = rows[0]?.code;
  if (code === undefined) {
    throw new ApplicationPersistenceError('Processing-code mint returned no row');
  }
  return code;
}

/**
 * INSERT the applications row at SUBMITTED in the owning agency's ops schema.
 *
 * When `identifiers` is supplied the id and processing code are written
 * EXPLICITLY. The idempotent path needs that: it writes the ledger row first
 * (so concurrent requests serialise on the ledger's primary key), and the
 * ledger row has to carry the identifiers it is recording.
 *
 * May raise a 23505 on `uq_<agency>_applications_live_intent` — the engine
 * refusing a second live application for one (applicant, campaign, category).
 * That is a BUSINESS outcome, not a fault; the caller classifies it with
 * `isLiveIntentViolation` rather than letting it surface as a 500.
 */
export async function insertSubmittedApplication(
  tx: SqlTransaction,
  target: AgencyTarget,
  input: FrontDoorApplicationRow,
  identifiers?: CreateApplicationResult,
): Promise<CreateApplicationResult> {
  const schema = sql(target.schema); // quoted identifier fragment
  const seqName = `${target.schema}.processing_code_seq`;

  // Two shapes of the SAME insert: with caller-chosen identifiers, or with a
  // defaulted id and a code minted inline from the sequence.
  const inserted =
    identifiers === undefined
      ? await tx<{ id: string; processing_code: string }[]>`
          INSERT INTO ${schema}.applications
            (processing_code, applicant_id, campaign_id, category, status,
             nesa_index_number, hec_registration_number, submitted_at)
          VALUES (
            ${target.codePrefix} || '-' || lpad(nextval(${seqName}::regclass)::text, 5, '0'),
            ${input.applicantId},
            ${input.campaignId},
            ${input.category}::${schema}.application_category,
            'SUBMITTED',
            ${input.nesaIndexNumber},
            ${input.hecRegistrationNumber},
            now()
          )
          RETURNING id, processing_code
        `
      : await tx<{ id: string; processing_code: string }[]>`
          INSERT INTO ${schema}.applications
            (id, processing_code, applicant_id, campaign_id, category, status,
             nesa_index_number, hec_registration_number, submitted_at)
          VALUES (
            ${identifiers.applicationId},
            ${identifiers.processingCode},
            ${input.applicantId},
            ${input.campaignId},
            ${input.category}::${schema}.application_category,
            'SUBMITTED',
            ${input.nesaIndexNumber},
            ${input.hecRegistrationNumber},
            now()
          )
          RETURNING id, processing_code
        `;

  const row = inserted[0];
  if (!row) {
    throw new ApplicationPersistenceError('Application insert returned no row');
  }
  return { applicationId: row.id, processingCode: row.processing_code };
}

/** The immutable trail's opening entry (null → SUBMITTED), written by SYSTEM. */
export async function insertOpeningHistory(
  tx: SqlTransaction,
  target: AgencyTarget,
  applicationId: string,
  correlationId: string,
): Promise<void> {
  const schema = sql(target.schema);
  await tx`
    INSERT INTO ${schema}.application_status_history
      (application_id, from_status, to_status, reason, performed_by, correlation_id)
    VALUES (
      ${applicationId},
      NULL,
      'SUBMITTED',
      'Application submitted via front door',
      'SYSTEM',
      ${correlationId}
    )
  `;
}

/** Shape of the fields postgres.js attaches to a server error. */
interface PgError {
  readonly code?: unknown;
  readonly constraint_name?: unknown;
}

/**
 * Is this the live-intent partial unique index refusing a duplicate?
 *
 * Matched on the CONSTRAINT NAME, not merely on SQLSTATE 23505: the
 * applications table carries other unique constraints (processing_code, and
 * qr_invitation_code on the walk-in lane), and silently reporting one of
 * those as "you already applied" would be a lie that hides a real bug.
 *
 * The three index names come from rls/0022_submission_integrity.sql:
 *   uq_rdf_applications_live_intent, uq_rnp_…, uq_rcs_…
 */
export function isLiveIntentViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, constraint_name: constraint } = err as PgError;
  return (
    code === '23505' &&
    typeof constraint === 'string' &&
    /^uq_(rdf|rnp|rcs)_applications_live_intent$/.test(constraint)
  );
}

/**
 * The citizen's existing LIVE application for this campaign + category, if
 * any — the row the live-intent index protects. `status <> 'WITHDRAWN'`
 * mirrors that index's predicate EXACTLY; if the two ever disagree, the
 * pre-flight check and the engine's refusal would disagree too.
 */
export async function findLiveApplication(
  tx: SqlTransaction,
  target: AgencyTarget,
  applicantId: string,
  campaignId: string,
  category: ApplicationCategory,
): Promise<CreateApplicationResult | null> {
  const schema = sql(target.schema);
  const rows = await tx<{ id: string; processing_code: string }[]>`
    SELECT id, processing_code
    FROM ${schema}.applications
    WHERE applicant_id = ${applicantId}
      AND campaign_id = ${campaignId}
      AND category = ${category}::${schema}.application_category
      AND status <> 'WITHDRAWN'
    LIMIT 1
  `;
  const row = rows[0];
  return row === undefined
    ? null
    : { applicationId: row.id, processingCode: row.processing_code };
}
