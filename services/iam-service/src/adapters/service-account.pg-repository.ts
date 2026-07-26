// ══════════════════════════════════════════════════════════════════
// iam-service — ServiceAccountRepository adapter (PostgreSQL)
//
// Reads the machine credential store AS usrp_iam_service — the ONLY role
// granted on public_core.service_accounts (rls/0015), exactly mirroring the
// officer store. Deliberately no grant to usrp_system_service: a compromised
// worker must not be able to read the digests that mint its own kind of
// token. FORCE'd RLS policy pc_sa_iam (USING true) — a client_id lookup has
// no narrower scope.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import type {
  ServiceAccountRecord,
  ServiceAccountRepository,
  ServiceAccountStatus,
} from '../ports/service-account-repository.js';
import { IamPersistenceError } from '../domain/iam.errors.js';

const IAM_DB_ROLE = 'usrp_iam_service';

interface ServiceAccountRow {
  readonly service_id: string;
  readonly client_id: string;
  readonly credential: string;
  readonly status: string;
}

export class PgServiceAccountRepository implements ServiceAccountRepository {
  async findByClientId(clientId: string): Promise<ServiceAccountRecord | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(IAM_DB_ROLE)}`;

        const rows = await tx<ServiceAccountRow[]>`
          SELECT service_id, client_id, credential, status
          FROM public_core.service_accounts
          WHERE client_id = ${clientId}
          LIMIT 1
        `;
        const row = rows[0];
        if (row === undefined) return null;

        // Fail closed: anything that is not exactly 'active' is disabled.
        const status: ServiceAccountStatus = row.status === 'active' ? 'active' : 'disabled';
        return {
          serviceId: row.service_id,
          clientId: row.client_id,
          credential: row.credential,
          status,
        };
      });
    } catch (err) {
      throw new IamPersistenceError('Failed to read service account', { cause: err });
    }
  }
}
