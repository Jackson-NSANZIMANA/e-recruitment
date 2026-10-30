// ══════════════════════════════════════════════════════════════════
// application-service — ClearanceAttachRepository adapter (PostgreSQL)
//
// One read as usrp_system_service across the three ops schemas. The ownership
// check IS the row lookup: WHERE id = X AND applicant_id = Y.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { AGENCIES, type ApplicationCategory, type ApplicationStatus, type CriminalClearanceStatus } from '@usrp/shared-types';
import { ApplicationReadError } from '../domain/application.errors.js';
import { schemaForAgency } from '../domain/agency-schema.js';
import type { ClearanceAttachRepository, OwnApplicationForClearance } from '../ports/clearance-attach-repository.js';

const SYSTEM_ROLE = 'usrp_system_service';

export class PgClearanceAttachRepository implements ClearanceAttachRepository {
  async findOwn(applicantId: string, applicationId: string): Promise<OwnApplicationForClearance | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        for (const agency of AGENCIES) {
          const schema = sql(schemaForAgency(agency));
          const rows = await tx<{ category: ApplicationCategory; status: ApplicationStatus; criminal: CriminalClearanceStatus; block: unknown }[]>`
            SELECT category::text AS category, status::text AS status, criminal_clearance_status::text AS criminal,
                   (SELECT pv.policy_document -> a.category::text -> 'v2' -> 'clearance'
                      FROM public_core.campaign_policy_versions pv WHERE pv.id = a.policy_version_id) AS block
            FROM ${schema}.applications a
            WHERE a.id = ${applicationId} AND a.applicant_id = ${applicantId}
          `;
          const row = rows[0];
          if (row !== undefined) return { agency, category: row.category, status: row.status, criminalStatus: row.criminal, clearancePolicy: readClearanceValues(row.block) };
        }
        return null;
      });
    } catch (cause) {
      throw new ApplicationReadError('Could not read the application for the clearance certificate.', { cause });
    }
  }
}

/** The clearance block of a stored v2 category, or null (v1 campaign, or damage). */
function readClearanceValues(block: unknown): OwnApplicationForClearance['clearancePolicy'] {
  if (block === null || typeof block !== 'object') return null;
  const b = block as Record<string, unknown>;
  const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v) : null);
  const allowed = strings(b['allowedCertificateCodes']);
  const noRecord = strings(b['noRecordCertificateCodes']);
  const days = b['validityDays'];
  if (allowed === null || noRecord === null || typeof days !== 'number') return null;
  return { allowedCertificateCodes: allowed, noRecordCertificateCodes: noRecord, validityDays: days };
}
