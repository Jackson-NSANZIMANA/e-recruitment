// ══════════════════════════════════════════════════════════════════
// application-service — DocumentChecklistRepository adapter (PostgreSQL)
//
// Reads run under the caller's scope: the officer's own agency role (so a
// sibling agency's id is simply absent), or usrp_system_service constrained by
// `applicant_id = <session subject>`. Only verdict columns and the document
// type list are read — no PII, no object keys, no forensic scores.
// ══════════════════════════════════════════════════════════════════

import { sql, type SqlTransaction } from '@usrp/shared-database';
import {
  AGENCIES,
  type Agency,
  type AcademicEligibilityStatus,
  type ApplicationCategory,
  type ApplicationStatus,
  type CriminalClearanceStatus,
  type DocumentType,
} from '@usrp/shared-types';
import { ApplicationPersistenceError, ApplicationReadError } from '../domain/application.errors.js';
import { schemaForAgency } from '../domain/agency-schema.js';
import type { ClearanceVerificationFacts, StoredDocument } from '../domain/document-requirements.js';
import type {
  ChecklistFacts,
  DocumentChecklistRepository,
  OfficerScope,
  VenueVerificationInput,
  VenueVerificationWrite,
} from '../ports/document-checklist-repository.js';

const SYSTEM_ROLE = 'usrp_system_service';
const LANES = new Set(['GREEN', 'AMBER', 'RED']);

interface ApplicationRow {
  category: ApplicationCategory;
  status: ApplicationStatus;
  academic_status: AcademicEligibilityStatus;
  criminal_clearance_status: CriminalClearanceStatus;
  identity_status: string;
  required: unknown;
}

interface DocumentRow {
  document_type: DocumentType;
  forensics_lane: string | null;
  verified_via_api: boolean | null;
  human_review_decision: string | null;
  virus_scan_status: string | null;
  venue_verified: boolean;
}

/** A policy list is honoured only if it is a JSON array of strings. */
function policyList(value: unknown): readonly DocumentType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((v): v is string => typeof v === 'string') ? (value as DocumentType[]) : undefined;
}

async function readFacts(
  tx: SqlTransaction,
  agency: Agency,
  applicationId: string,
  applicantId: string | null,
): Promise<ChecklistFacts | null> {
  const schema = sql(schemaForAgency(agency));
  const rows = await tx<ApplicationRow[]>`
    SELECT a.category::text AS category,
           a.status::text AS status,
           a.academic_status::text AS academic_status,
           a.criminal_clearance_status::text AS criminal_clearance_status,
           ai.identity_status::text AS identity_status,
           pv.policy_document -> (a.category::text) -> 'requiredDocumentTypes' AS required
    FROM ${schema}.applications a
    JOIN public_core.applicant_identities ai ON ai.id = a.applicant_id
    LEFT JOIN public_core.campaign_policy_versions pv ON pv.id = a.policy_version_id
    WHERE a.id = ${applicationId}
      AND (${applicantId}::uuid IS NULL OR a.applicant_id = ${applicantId}::uuid)
  `;
  const row = rows[0];
  if (row === undefined) return null;
  const docs = await tx<DocumentRow[]>`
    SELECT document_type::text AS document_type,
           forensics_lane::text AS forensics_lane,
           verified_via_api,
           human_review_decision,
           virus_scan_status,
           (venue_verified_by_id IS NOT NULL) AS venue_verified
    FROM ${schema}.document_records
    WHERE application_id = ${applicationId}
  `;
  // The latest Irembo certificate verification (rls/0040): closed codes only.
  const verification = await tx<{ outcome: string; failure_code: string | null; review_reasons: string[] }[]>`
    SELECT outcome, failure_code, review_reasons
    FROM ${schema}.clearance_certificate_verifications
    WHERE application_id = ${applicationId}
    ORDER BY verified_at DESC, id DESC
    LIMIT 1
  `;
  const latest = verification[0];
  return {
    agency,
    category: row.category,
    status: row.status,
    policyRequired: policyList(row.required),
    gates: {
      identityVerified: row.identity_status === 'VERIFIED',
      academicStatus: row.academic_status,
      criminalStatus: row.criminal_clearance_status,
      clearance: latest === undefined
        ? null
        : { outcome: latest.outcome as ClearanceVerificationFacts['outcome'], failureCode: latest.failure_code, reviewReasons: latest.review_reasons },
    },
    documents: docs.map(
      (d): StoredDocument => ({
        documentType: d.document_type,
        forensicsLane: d.forensics_lane !== null && LANES.has(d.forensics_lane)
          ? (d.forensics_lane as StoredDocument['forensicsLane'])
          : null,
        verifiedViaApi: d.verified_via_api === true,
        humanReviewDecision:
          d.human_review_decision === 'CLEAR' || d.human_review_decision === 'REJECT'
            ? d.human_review_decision
            : null,
        virusScanPassed: d.virus_scan_status === 'CLEAN',
        venueVerified: d.venue_verified,
      }),
    ),
  };
}

export class PgDocumentChecklistRepository implements DocumentChecklistRepository {
  async loadForOfficer(scope: OfficerScope, applicationId: string): Promise<ChecklistFacts | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(scope.dbRole)}`;
        return await readFacts(tx, scope.agency, applicationId, null);
      });
    } catch (cause) {
      throw new ApplicationReadError('Could not read the document checklist.', { cause });
    }
  }

  async loadForApplicant(applicantId: string, applicationId: string): Promise<ChecklistFacts | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        // A citizen is cross-agency; the subject filter is what scopes the read.
        for (const agency of AGENCIES) {
          const facts = await readFacts(tx, agency, applicationId, applicantId);
          if (facts !== null) return facts;
        }
        return null;
      });
    } catch (cause) {
      throw new ApplicationReadError('Could not read the document checklist.', { cause });
    }
  }

  async recordVenueVerification(input: VenueVerificationInput): Promise<VenueVerificationWrite> {
    const schema = sql(schemaForAgency(input.agency));
    try {
      return await sql.begin(async (tx): Promise<VenueVerificationWrite> => {
        await tx`SET LOCAL ROLE ${sql(input.dbRole)}`;
        // The partial unique index uq_<agency>_docs_venue_once is the arbiter:
        // a concurrent second sighting loses the insert and reads as already done.
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO ${schema}.document_records
            (application_id, document_type, venue_verified_by_id, venue_verified_at)
          VALUES (${input.applicationId}, ${input.documentType}::${schema}.document_type,
                  ${input.officerId}, now())
          ON CONFLICT (application_id, document_type) WHERE venue_verified_by_id IS NOT NULL
          DO NOTHING
          RETURNING id
        `;
        return inserted.length === 1 ? 'RECORDED' : 'ALREADY_RECORDED';
      });
    } catch (cause) {
      throw new ApplicationPersistenceError('Could not record the venue verification.', { cause });
    }
  }
}
