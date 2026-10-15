// application-service — ExamInvitationReader adapter (PostgreSQL, ADR-033)
//
// usrp_system_service, constrained by applicant_id = the session subject (the
// citizen is cross-agency, so the three ops schemas are searched in turn).

import { sql } from '@usrp/shared-database';
import { AGENCIES, type ApplicationStatus } from '@usrp/shared-types';
import { ApplicationReadError } from '../domain/application.errors.js';
import { schemaForAgency } from '../domain/agency-schema.js';
import type { ExamInvitationReader, InvitationRow } from '../ports/exam-invitation-reader.js';

const SYSTEM_ROLE = 'usrp_system_service';

export class PgExamInvitationReader implements ExamInvitationReader {
  async findForApplicant(applicantId: string, applicationId: string): Promise<InvitationRow | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        for (const agency of AGENCIES) {
          const schema = sql(schemaForAgency(agency));
          const rows = await tx<{
            status: ApplicationStatus;
            processing_code: string;
            campaign_label: string | null;
            token: string | null;
            admitted_at: Date | null;
            admitted_venue: string | null;
          }[]>`
            SELECT a.status::text AS status, a.processing_code, c.campaign_label, a.qr_signed_token AS token,
                   g.admitted_at, g.venue_name AS admitted_venue
            FROM ${schema}.applications a
            LEFT JOIN public_core.recruitment_campaigns c ON c.id = a.campaign_id
            LEFT JOIN ${schema}.gate_admissions g ON g.application_id = a.id
            WHERE a.id = ${applicationId} AND a.applicant_id = ${applicantId}
          `;
          const row = rows[0];
          if (row !== undefined) {
            return {
              agency,
              status: row.status,
              processingCode: row.processing_code,
              campaignLabel: row.campaign_label,
              token: row.token,
              admission: row.admitted_at === null || row.admitted_venue === null
                ? null
                : { admittedAt: row.admitted_at.toISOString(), venueName: row.admitted_venue },
            };
          }
        }
        return null;
      });
    } catch (cause) {
      throw new ApplicationReadError('Could not read the exam invitation.', { cause });
    }
  }
}
