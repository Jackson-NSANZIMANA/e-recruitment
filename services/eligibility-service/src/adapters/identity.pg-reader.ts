// ══════════════════════════════════════════════════════════════════
// eligibility-service — IdentityReader adapter (PostgreSQL + pgcrypto)
//
// Reads applicant_identities as the `usrp_system_service` role (the app
// connects as the privilege-less usrp_app login and SET ROLEs per
// request) and decrypts the date-of-birth PII column with the pgcrypto
// key set TRANSACTION-LOCAL so it never leaks onto the pooled connection —
// the same idiom the identity-service repository writes with. RLS lets the
// system service see every applicant.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import type { IdentityVerificationStatus } from '@usrp/shared-database';
import type { ApplicantIdentityRecord, IdentityReader } from '../ports/identity-reader.js';
import { EligibilityReadError } from '../domain/eligibility.errors.js';

const SYSTEM_ROLE = 'usrp_system_service';
const ENCRYPTION_KEY_SETTING = 'app.encryption_key';

export class PgIdentityReader implements IdentityReader {
  /** @param encryptionKey pgcrypto key, set per-transaction as app.encryption_key. */
  constructor(private readonly encryptionKey: string) {}

  async findApplicantById(applicantId: string): Promise<ApplicantIdentityRecord | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        await tx`SELECT set_config(${ENCRYPTION_KEY_SETTING}, ${this.encryptionKey}, true)`;

        const rows = await tx<{ date_of_birth: string; identity_status: IdentityVerificationStatus }[]>`
          SELECT
            pgp_sym_decrypt(encrypted_date_of_birth::bytea, current_setting(${ENCRYPTION_KEY_SETTING})) AS date_of_birth,
            identity_status
          FROM public_core.applicant_identities
          WHERE id = ${applicantId}
            AND deleted_at IS NULL
          LIMIT 1
        `;

        const row = rows[0];
        if (!row) return null;
        return { dateOfBirth: row.date_of_birth, identityStatus: row.identity_status };
      });
    } catch (cause) {
      throw new EligibilityReadError('Failed to read applicant identity', { cause });
    }
  }
}
