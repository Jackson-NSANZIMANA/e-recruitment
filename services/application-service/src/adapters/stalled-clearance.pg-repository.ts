// application-service — StalledClearanceRepository adapter (PostgreSQL)
//
// usrp_system_service, per agency schema. A row is stalled when it sits at
// DOCUMENT_REVIEW_GREEN with no slot projected (qr_invitation_code IS NULL) and
// its campaign can still hold an exam (REGISTRATION_OPEN / REGISTRATION_CLOSED
// / EXAMINATION_ACTIVE). Claiming bumps updated_at, which is the per-row
// backoff: the row is not re-announced again until it has been untouched for
// another full grace period.

import { sql } from '@usrp/shared-database';
import { AGENCIES, type ApplicationCategory, type USRPEvent } from '@usrp/shared-types';
import { ApplicationReadError } from '../domain/application.errors.js';
import { schemaForAgency } from '../domain/agency-schema.js';
import type { StalledClearance, StalledClearanceRepository } from '../ports/stalled-clearance-repository.js';
import { stageEvents } from './outbox/pg-event-outbox.js';

const SYSTEM_ROLE = 'usrp_system_service';

export class PgStalledClearanceRepository implements StalledClearanceRepository {
  async reannounce(
    untouchedSince: Date,
    limit: number,
    announce: (stalled: readonly StalledClearance[]) => readonly USRPEvent[],
  ): Promise<readonly USRPEvent[]> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const stalled: StalledClearance[] = [];
        for (const agency of AGENCIES) {
          const schema = sql(schemaForAgency(agency));
          const rows = await tx<{ id: string; applicant_id: string; campaign_id: string; category: ApplicationCategory }[]>`
            UPDATE ${schema}.applications a SET updated_at = now()
            WHERE a.id IN (
              SELECT s.id FROM ${schema}.applications s
              JOIN public_core.recruitment_campaigns c ON c.id = s.campaign_id
              WHERE s.status = 'DOCUMENT_REVIEW_GREEN'
                AND s.qr_invitation_code IS NULL
                AND s.updated_at < ${untouchedSince}
                AND c.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'EXAMINATION_ACTIVE')
              ORDER BY s.updated_at
              LIMIT ${limit}
              FOR UPDATE OF s SKIP LOCKED
            )
            RETURNING a.id, a.applicant_id, a.campaign_id, a.category::text AS category
          `;
          for (const r of rows) {
            stalled.push({
              applicationId: r.id,
              applicantId: r.applicant_id,
              agency,
              campaignId: r.campaign_id,
              category: r.category,
            });
          }
        }
        if (stalled.length === 0) return [];
        const events = announce(stalled);
        await stageEvents(tx, events);
        return events;
      });
    } catch (cause) {
      throw new ApplicationReadError('Could not re-announce stalled clearances.', { cause });
    }
  }
}
