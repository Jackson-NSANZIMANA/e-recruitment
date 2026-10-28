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
          const rows = await tx<{ category: ApplicationCategory; status: ApplicationStatus; criminal: CriminalClearanceStatus }[]>`
            SELECT category::text AS category, status::text AS status, criminal_clearance_status::text AS criminal
            FROM ${schema}.applications
            WHERE id = ${applicationId} AND applicant_id = ${applicantId}
          `;
          const row = rows[0];
          if (row !== undefined) return { agency, category: row.category, status: row.status, criminalStatus: row.criminal };
        }
        return null;
      });
    } catch (cause) {
      throw new ApplicationReadError('Could not read the application for the clearance certificate.', { cause });
    }
  }
}
