// ══════════════════════════════════════════════════════════════════
// application-service — SelfWithdrawalRepository adapter (PostgreSQL)
//
// One transaction as usrp_system_service (see the port header for why).
// The ownership check IS the row lookup: SELECT … WHERE id = X AND
// applicant_id = Y FOR UPDATE — a mismatch on either column yields the
// same NOT_FOUND, and the lock guarantees the status we read is the
// status we transition from (no lost update against a concurrent
// projection or officer act on the same row).
//
// Terminal statuses are compared as ::text — the rnp/rcs status enums do
// not carry the WALK_IN_* values, so enum-cast comparisons against the
// full terminal set would be a hard error on those schemas (ADR-017 idiom).
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { AGENCIES, type ApplicationStatus } from '@usrp/shared-types';
import { ApplicationPersistenceError } from '../domain/application.errors.js';
import { schemaForAgency } from '../domain/agency-schema.js';
import type {
  SelfWithdrawalRepository,
  WithdrawOwnInput,
  WithdrawOwnOutcome,
} from '../ports/self-withdrawal-repository.js';

/** Statuses a citizen cannot withdraw out of (compared as text — see header). */
const IMMOVABLE_TEXT: readonly string[] = ['REJECTED', 'ACCEPTED', 'WALK_IN_REJECTED'];

const SYSTEM_ROLE = 'usrp_system_service';

export class PgSelfWithdrawalRepository implements SelfWithdrawalRepository {
  async withdrawOwn(input: WithdrawOwnInput): Promise<WithdrawOwnOutcome> {
    const { applicantId, applicationId, correlationId } = input;
    try {
      return await sql.begin(async (tx): Promise<WithdrawOwnOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        for (const agency of AGENCIES) {
          const schema = sql(schemaForAgency(agency));

          const rows = await tx<{ id: string; status: ApplicationStatus }[]>`
            SELECT id, status FROM ${schema}.applications
            WHERE id = ${applicationId} AND applicant_id = ${applicantId}
            FOR UPDATE
          `;
          const row = rows[0];
          if (!row) continue;

          if (row.status === 'WITHDRAWN') {
            return { kind: 'NO_CHANGE', agency };
          }
          if (IMMOVABLE_TEXT.includes(row.status)) {
            return { kind: 'NOT_APPLICABLE', agency, status: row.status };
          }

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
              'Voluntary withdrawal by applicant (ADR-020)',
              'APPLICANT',
              ${correlationId}
            )
          `;
          return { kind: 'WITHDRAWN', agency, fromStatus: row.status };
        }

        return { kind: 'NOT_FOUND' };
      });
    } catch (cause) {
      throw new ApplicationPersistenceError('Failed to withdraw own application', { cause });
    }
  }
}
