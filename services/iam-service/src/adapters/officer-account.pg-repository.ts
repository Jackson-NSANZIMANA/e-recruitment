// ══════════════════════════════════════════════════════════════════
// iam-service — OfficerAccountRepository adapter (PostgreSQL)
//
// Reads the credential store AS usrp_iam_service — the ONLY role granted on
// public_core.officer_accounts (rls/0010). No other service can assume a role
// that reads password hashes, so the credential surface's blast radius is
// confined to iam-service at the database engine, not merely in code. usrp_app
// is a member of usrp_iam_service (rls/0001), so `SET LOCAL ROLE` succeeds; the
// FORCE'd RLS policy pc_oa_iam (USING true) lets login resolve a handle across
// agencies before the agency is known.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import type { Agency } from '@usrp/shared-types';
import type {
  OfficerAccountRecord,
  OfficerAccountRepository,
  OfficerAccountStatus,
} from '../ports/officer-account-repository.js';
import { IamPersistenceError } from '../domain/iam.errors.js';

/** The least-privilege role that alone may read the credential store. */
const IAM_DB_ROLE = 'usrp_iam_service';

interface OfficerAccountRow {
  readonly officer_id: string;
  readonly login_handle: string;
  readonly credential: string;
  readonly agency: Agency;
  readonly roles: readonly string[];
  readonly status: string;
}

export class PgOfficerAccountRepository implements OfficerAccountRepository {
  async findByHandle(loginHandle: string): Promise<OfficerAccountRecord | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(IAM_DB_ROLE)}`;

        const rows = await tx<OfficerAccountRow[]>`
          SELECT officer_id, login_handle, credential, agency, roles, status
          FROM public_core.officer_accounts
          WHERE login_handle = ${loginHandle}
          LIMIT 1
        `;
        const row = rows[0];
        if (row === undefined) return null;

        // Fail closed: any status that is not exactly 'active' is treated as
        // disabled by the login use case.
        const status: OfficerAccountStatus = row.status === 'active' ? 'active' : 'disabled';
        return {
          officerId: row.officer_id,
          loginHandle: row.login_handle,
          credential: row.credential,
          agency: row.agency,
          roles: row.roles,
          status,
        };
      });
    } catch (err) {
      throw new IamPersistenceError('Failed to read officer account', { cause: err });
    }
  }
}
