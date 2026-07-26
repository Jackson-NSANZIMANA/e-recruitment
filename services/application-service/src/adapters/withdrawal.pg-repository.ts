// ══════════════════════════════════════════════════════════════════
// application-service — WithdrawalRepository adapter (PostgreSQL)
//
// One transaction as usrp_system_service across ALL THREE ops schemas —
// the only role that can see them all, and the honest author of a
// platform-level consequence (no officer decided the siblings' fate; the
// acceptance did). Per schema:
//
//   1. SELECT ... FOR UPDATE the applicant's non-terminal applications,
//      excluding the accepted one. The terminal set is compared as ::text —
//      the rnp/rcs status enums do not carry the WALK_IN_* values, so an
//      enum-cast IN-list would be a hard error on those schemas.
//   2. UPDATE each to WITHDRAWN + append the status-history row
//      (append-only per rls/0007; performed_by 'SYSTEM', the projection
//      convention — the audit trail carries the richer attribution).
//
// All-or-nothing: a fault anywhere rolls back every withdrawal, the
// consumer's offset stays uncommitted, and redelivery retries the whole
// set. A redelivery after success finds nothing non-terminal → [] → no-op.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { AGENCIES, type Agency, type ApplicationStatus } from '@usrp/shared-types';
import { ApplicationPersistenceError } from '../domain/application.errors.js';
import { schemaForAgency } from '../domain/agency-schema.js';
import type {
  WithdrawalRepository,
  WithdrawnApplication,
  WithdrawSiblingsInput,
} from '../ports/withdrawal-repository.js';

/** Statuses the withdrawal never touches (compared as text — see header). */
const TERMINAL_TEXT: readonly string[] = ['REJECTED', 'WITHDRAWN', 'ACCEPTED', 'WALK_IN_REJECTED'];

const SYSTEM_ROLE = 'usrp_system_service';

export class PgWithdrawalRepository implements WithdrawalRepository {
  async withdrawSiblings(input: WithdrawSiblingsInput): Promise<readonly WithdrawnApplication[]> {
    const { applicantId, acceptedApplicationId, correlationId } = input;
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        const withdrawn: WithdrawnApplication[] = [];
        for (const agency of AGENCIES) {
          const schema = sql(schemaForAgency(agency));

          const rows = await tx<{ id: string; status: ApplicationStatus }[]>`
            SELECT id, status FROM ${schema}.applications
            WHERE applicant_id = ${applicantId}
              AND id != ${acceptedApplicationId}
              AND status::text NOT IN ${tx(TERMINAL_TEXT as string[])}
            FOR UPDATE
          `;

          for (const row of rows) {
            await tx`
              UPDATE ${schema}.applications SET
                status = 'WITHDRAWN'::${schema}.application_status,
                updated_at = now()
              WHERE id = ${row.id}
            `;
            await tx`
              INSERT INTO ${schema}.application_status_history
                (application_id, from_status, to_status, reason, performed_by, correlation_id)
              VALUES (
                ${row.id},
                ${row.status}::${schema}.application_status,
                'WITHDRAWN'::${schema}.application_status,
                'Auto-withdrawn: applicant accepted elsewhere (ADR-017)',
                'SYSTEM',
                ${correlationId}
              )
            `;
            withdrawn.push(withdrawnRow(row.id, agency, row.status));
          }
        }
        return withdrawn;
      });
    } catch (cause) {
      throw new ApplicationPersistenceError('Failed to auto-withdraw sibling applications', {
        cause,
      });
    }
  }
}

function withdrawnRow(applicationId: string, agency: Agency, fromStatus: ApplicationStatus): WithdrawnApplication {
  return { applicationId, agency, fromStatus };
}
