// ══════════════════════════════════════════════════════════════════
// application-service — ApplicationReadRepository adapter (PostgreSQL)
//
// Reads an agency's applications as the OFFICER's DB role. This is the first
// production code path to `SET LOCAL ROLE usrp_<agency>_officer` rather than
// usrp_system_service — the seam that activates the dormant per-agency
// isolation from rls/0001. Two layers of defense stack here:
//
//   1. The agency comes from the verified token (never a query param), so the
//      query targets only the caller's own ops schema.
//   2. Even so, the officer DB role has NO usage/grant on sibling ops schemas,
//      so a mis-routed query would raise permission-denied, not leak.
//
// Only non-PII columns are selected — the anonymous processing code officers
// are meant to see, never a name or National ID.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import type { ApplicationCategory, ApplicationStatus } from '@usrp/shared-types';
import type {
  AmberQueueEntry,
  ApplicationReadRepository,
  ApplicationSummary,
  ListByAgencyInput,
} from '../ports/application-read-repository.js';
import { ApplicationReadError } from '../domain/application.errors.js';
import { schemaForAgency } from '../domain/agency-schema.js';

/** The non-PII columns the officer listing exposes. */
interface ApplicationSummaryRow {
  readonly id: string;
  readonly processing_code: string;
  readonly category: ApplicationCategory;
  readonly status: ApplicationStatus;
  readonly submitted_at: Date | null;
}

export class PgApplicationReadRepository implements ApplicationReadRepository {
  async listByAgency(input: ListByAgencyInput): Promise<readonly ApplicationSummary[]> {
    const schema = sql(schemaForAgency(input.agency)); // quoted identifier fragment
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(input.dbRole)}`;
        const rows = await tx<ApplicationSummaryRow[]>`
          SELECT id, processing_code, category, status, submitted_at
          FROM ${schema}.applications
          ORDER BY submitted_at DESC NULLS LAST
          LIMIT ${input.limit}
        `;
        return rows.map(toSummary);
      });
    } catch (err) {
      throw new ApplicationReadError('Could not list applications for the agency.', { cause: err });
    }
  }

  async listAmberQueue(input: ListByAgencyInput): Promise<readonly AmberQueueEntry[]> {
    const schema = sql(schemaForAgency(input.agency)); // quoted identifier fragment
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(input.dbRole)}`;
        // AMBER holds join their yet-unreviewed flagged document; adjudication
        // holds carry no document (a late vetting flag, not a document issue).
        // LEFT JOIN keeps an amber application visible even if its document
        // row was already stamped (defensive — the queue must never lose apps).
        const rows = await tx<AmberQueueRow[]>`
          SELECT a.id, a.processing_code, a.status,
                 d.document_type, d.forensics_score, d.forensics_flags, d.forensics_completed_at
          FROM ${schema}.applications a
          LEFT JOIN ${schema}.document_records d
            ON d.application_id = a.id
           AND d.forensics_lane = 'AMBER'::${schema}.document_lane
           AND d.human_reviewed_by_id IS NULL
          WHERE a.status IN ('DOCUMENT_REVIEW_AMBER'::${schema}.application_status,
                             'ADJUDICATION_REVIEW'::${schema}.application_status)
          ORDER BY d.forensics_completed_at ASC NULLS LAST, a.updated_at ASC
          LIMIT ${input.limit}
        `;
        return rows.map(toQueueEntry);
      });
    } catch (err) {
      throw new ApplicationReadError('Could not list the review queue for the agency.', { cause: err });
    }
  }
}

/** The non-PII review-queue columns (document fields null for late holds). */
interface AmberQueueRow {
  readonly id: string;
  readonly processing_code: string;
  readonly status: ApplicationStatus;
  readonly document_type: string | null;
  readonly forensics_score: number | null;
  readonly forensics_flags: Record<string, unknown> | null;
  readonly forensics_completed_at: Date | null;
}

function toQueueEntry(row: AmberQueueRow): AmberQueueEntry {
  return {
    applicationId: row.id,
    processingCode: row.processing_code,
    status: row.status,
    documentType: row.document_type,
    forensicsScore: row.forensics_score,
    forensicsFlags: row.forensics_flags,
    queuedAt: row.forensics_completed_at === null ? null : row.forensics_completed_at.toISOString(),
  };
}

function toSummary(row: ApplicationSummaryRow): ApplicationSummary {
  return {
    applicationId: row.id,
    processingCode: row.processing_code,
    category: row.category,
    status: row.status,
    submittedAt: row.submitted_at === null ? null : row.submitted_at.toISOString(),
  };
}
