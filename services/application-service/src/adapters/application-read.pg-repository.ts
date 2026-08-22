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
import { AGENCIES, type Agency } from '@usrp/shared-types';
import type {
  AmberQueueEntry,
  ApplicantApplicationSummary,
  ApplicationDetail,
  ApplicationReadRepository,
  ApplicationSummary,
  ListByAgencyInput,
  ReadOneInput,
  StatusHistoryEntry,
} from '../ports/application-read-repository.js';
import { ApplicationReadError } from '../domain/application.errors.js';
import { schemaForAgency } from '../domain/agency-schema.js';

/** timestamptz — the shared client may surface it as a Date or an ISO string. */
type Timestamptz = Date | string;

/** ISO-normalise a nullable timestamptz coming off the wire. */
function iso(value: Timestamptz | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** ISO-normalise a NOT NULL timestamptz. */
function isoRequired(value: Timestamptz): string {
  return new Date(value).toISOString();
}

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

  async listByApplicant(applicantId: string): Promise<readonly ApplicantApplicationSummary[]> {
    try {
      return await sql.begin(async (tx) => {
        // System role: the ONLY role that can see all three ops schemas —
        // this is the citizen's own cross-agency view, not an officer's.
        await tx`SET LOCAL ROLE ${sql('usrp_system_service')}`;
        const all: ApplicantApplicationSummary[] = [];
        for (const agency of AGENCIES) {
          const schema = sql(schemaForAgency(agency));
          const rows = await tx<ApplicationSummaryRow[]>`
            SELECT id, processing_code, category, status, submitted_at
            FROM ${schema}.applications
            WHERE applicant_id = ${applicantId}
            ORDER BY submitted_at DESC NULLS LAST
          `;
          all.push(...rows.map((row) => toApplicantSummary(row, agency)));
        }
        return all;
      });
    } catch (err) {
      throw new ApplicationReadError('Could not list the applicant’s applications.', { cause: err });
    }
  }

  /**
   * ONE application, from the caller's OWN schema only.
   *
   * The column list is the THREE-SCHEMA INTERSECTION on purpose — see the
   * port docs. Adding medical_reviewed_* or is_walk_in here would make this
   * method throw for RCS officers and only RCS officers.
   *
   * qr_invitation_code is excluded deliberately: it is a bearer credential
   * scanned at the venue, not a display field. Only its ISSUED timestamp is
   * returned, which is all the UI needs to say "invitation sent".
   */
  async findById(input: ReadOneInput): Promise<ApplicationDetail | null> {
    const schema = sql(schemaForAgency(input.agency)); // quoted identifier fragment
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(input.dbRole)}`;
        const rows = await tx<ApplicationDetailRow[]>`
          SELECT id, processing_code, category, status,
                 nesa_index_number, nesa_verified_at,
                 hec_registration_number, hec_verified_at,
                 declared_specialist_field,
                 academic_status, academic_eligibility_detail,
                 age_eligibility_status, age_verified_at, age_eligibility_detail,
                 criminal_clearance_status, criminal_clearance_at,
                 document_lane, document_forensics_score, document_forensics_flags,
                 document_reviewed_by_id, document_reviewed_at, document_review_decision,
                 assigned_district, assigned_venue_name,
                 physical_test_scheduled_at, physical_test_completed_at,
                 qr_invitation_issued_at, sms_notification_sent_at,
                 final_decision_by_id, final_decision_at, final_decision_notes,
                 submitted_at, created_at, updated_at
          FROM ${schema}.applications
          WHERE id = ${input.applicationId}
          LIMIT 1
        `;
        const row = rows[0];
        return row === undefined ? null : toDetail(row);
      });
    } catch (err) {
      throw new ApplicationReadError('Could not read the application.', { cause: err });
    }
  }

  /**
   * The append-only status trail, oldest first.
   *
   * The existence probe and the history read share ONE transaction and ONE
   * assumed role: without the probe, an application id from a sibling agency
   * would return an empty array that the console could not distinguish from a
   * real record whose timeline failed to load. Every application has at least
   * one row (null→SUBMITTED at the front door), so "exists but empty" is not a
   * legitimate state and must not be rendered as one.
   *
   * Ordered by performed_at, then id: two transitions can share a timestamp
   * (a projection advancing twice inside one transaction), and an unstable
   * sort in a legal record is not acceptable.
   */
  async listStatusHistory(input: ReadOneInput): Promise<readonly StatusHistoryEntry[] | null> {
    const schema = sql(schemaForAgency(input.agency)); // quoted identifier fragment
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(input.dbRole)}`;

        const existing = await tx<{ readonly id: string }[]>`
          SELECT id FROM ${schema}.applications WHERE id = ${input.applicationId} LIMIT 1
        `;
        if (existing[0] === undefined) return null;

        const rows = await tx<StatusHistoryRow[]>`
          SELECT id, from_status, to_status, reason, performed_by, performed_at, correlation_id
          FROM ${schema}.application_status_history
          WHERE application_id = ${input.applicationId}
          ORDER BY performed_at ASC, id ASC
        `;
        return rows.map(toHistoryEntry);
      });
    } catch (err) {
      throw new ApplicationReadError('Could not read the application status history.', { cause: err });
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
  /** timestamptz — the shared client may surface it as Date or ISO string. */
  readonly forensics_completed_at: Date | string | null;
}

/** The three-schema-portable detail columns. No applicant_id, no QR code. */
interface ApplicationDetailRow {
  readonly id: string;
  readonly processing_code: string;
  readonly category: ApplicationCategory;
  readonly status: ApplicationStatus;
  readonly nesa_index_number: string | null;
  readonly nesa_verified_at: Timestamptz | null;
  readonly hec_registration_number: string | null;
  readonly hec_verified_at: Timestamptz | null;
  readonly declared_specialist_field: string | null;
  readonly academic_status: string;
  readonly academic_eligibility_detail: Record<string, unknown> | null;
  readonly age_eligibility_status: string;
  readonly age_verified_at: Timestamptz | null;
  readonly age_eligibility_detail: Record<string, unknown> | null;
  readonly criminal_clearance_status: string;
  readonly criminal_clearance_at: Timestamptz | null;
  readonly document_lane: string | null;
  readonly document_forensics_score: number | null;
  readonly document_forensics_flags: Record<string, unknown> | null;
  readonly document_reviewed_by_id: string | null;
  readonly document_reviewed_at: Timestamptz | null;
  readonly document_review_decision: string | null;
  readonly assigned_district: string | null;
  readonly assigned_venue_name: string | null;
  readonly physical_test_scheduled_at: Timestamptz | null;
  readonly physical_test_completed_at: Timestamptz | null;
  readonly qr_invitation_issued_at: Timestamptz | null;
  readonly sms_notification_sent_at: Timestamptz | null;
  readonly final_decision_by_id: string | null;
  readonly final_decision_at: Timestamptz | null;
  readonly final_decision_notes: string | null;
  readonly submitted_at: Timestamptz | null;
  readonly created_at: Timestamptz;
  readonly updated_at: Timestamptz;
}

/** One immutable status-trail row (rls/0007). */
interface StatusHistoryRow {
  readonly id: string;
  readonly from_status: ApplicationStatus | null;
  readonly to_status: ApplicationStatus;
  readonly reason: string | null;
  /** 'SYSTEM' or an officer UUID (varchar(50) by schema). */
  readonly performed_by: string;
  readonly performed_at: Timestamptz;
  readonly correlation_id: string | null;
}

function toQueueEntry(row: AmberQueueRow): AmberQueueEntry {
  return {
    applicationId: row.id,
    processingCode: row.processing_code,
    status: row.status,
    documentType: row.document_type,
    forensicsScore: row.forensics_score,
    forensicsFlags: row.forensics_flags,
    queuedAt:
      row.forensics_completed_at === null
        ? null
        : new Date(row.forensics_completed_at).toISOString(),
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

function toApplicantSummary(row: ApplicationSummaryRow, agency: Agency): ApplicantApplicationSummary {
  return { ...toSummary(row), agency };
}

function toDetail(row: ApplicationDetailRow): ApplicationDetail {
  return {
    applicationId: row.id,
    processingCode: row.processing_code,
    category: row.category,
    status: row.status,

    nesaIndexNumber: row.nesa_index_number,
    nesaVerifiedAt: iso(row.nesa_verified_at),
    hecRegistrationNumber: row.hec_registration_number,
    hecVerifiedAt: iso(row.hec_verified_at),
    declaredSpecialistField: row.declared_specialist_field,
    academicStatus: row.academic_status,
    academicEligibilityDetail: row.academic_eligibility_detail,

    ageEligibilityStatus: row.age_eligibility_status,
    ageVerifiedAt: iso(row.age_verified_at),
    ageEligibilityDetail: row.age_eligibility_detail,

    criminalClearanceStatus: row.criminal_clearance_status,
    criminalClearanceAt: iso(row.criminal_clearance_at),

    documentLane: row.document_lane,
    documentForensicsScore: row.document_forensics_score,
    documentForensicsFlags: row.document_forensics_flags,
    documentReviewedById: row.document_reviewed_by_id,
    documentReviewedAt: iso(row.document_reviewed_at),
    documentReviewDecision: row.document_review_decision,

    assignedDistrict: row.assigned_district,
    assignedVenueName: row.assigned_venue_name,
    physicalTestScheduledAt: iso(row.physical_test_scheduled_at),
    physicalTestCompletedAt: iso(row.physical_test_completed_at),
    qrInvitationIssuedAt: iso(row.qr_invitation_issued_at),
    smsNotificationSentAt: iso(row.sms_notification_sent_at),

    finalDecisionById: row.final_decision_by_id,
    finalDecisionAt: iso(row.final_decision_at),
    finalDecisionNotes: row.final_decision_notes,

    submittedAt: iso(row.submitted_at),
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

function toHistoryEntry(row: StatusHistoryRow): StatusHistoryEntry {
  return {
    entryId: row.id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    note: row.reason,
    actor: row.performed_by,
    // Derived once here rather than string-matching 'SYSTEM' in three UI
    // components. The schema stores either the literal 'SYSTEM' or an
    // officer UUID (the token `sub`), so anything else IS an officer.
    actorKind: row.performed_by === 'SYSTEM' ? 'SYSTEM' : 'OFFICER',
    at: isoRequired(row.performed_at),
    correlationId: row.correlation_id,
  };
}
