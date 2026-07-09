// ══════════════════════════════════════════════════════════════════
// scheduling-service — HomeDistrictReader adapter (PostgreSQL + pgcrypto)
//
// Reads applicant_identities as usrp_system_service (the app connects as the
// privilege-less usrp_app login and SET ROLEs per request) and decrypts the
// home-district PII column with the pgcrypto key set TRANSACTION-LOCAL so it
// never leaks onto the pooled connection — the same idiom the eligibility age
// gate uses for date-of-birth. RLS lets the system service see every applicant.
// The plaintext district is used ONLY to resolve a venue and never leaves this
// service in an event or log — only the resolved venue does.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import type { HomeDistrictReader } from '../ports/readers.js';
import { SchedulingReadError } from '../domain/scheduling.errors.js';

const SYSTEM_ROLE = 'usrp_system_service';
const ENCRYPTION_KEY_SETTING = 'app.encryption_key';

export class PgHomeDistrictReader implements HomeDistrictReader {
  /** @param encryptionKey pgcrypto key, set per-transaction as app.encryption_key. */
  constructor(private readonly encryptionKey: string) {}

  async homeDistrictOf(applicantId: string): Promise<string | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        await tx`SELECT set_config(${ENCRYPTION_KEY_SETTING}, ${this.encryptionKey}, true)`;

        const rows = await tx<{ home_district: string }[]>`
          SELECT
            pgp_sym_decrypt(encrypted_home_district::bytea, current_setting(${ENCRYPTION_KEY_SETTING})) AS home_district
          FROM public_core.applicant_identities
          WHERE id = ${applicantId}
            AND deleted_at IS NULL
          LIMIT 1
        `;

        const row = rows[0];
        if (!row) return null;
        // Normalise to the uppercase code the venue seed keys on.
        return row.home_district.trim().toUpperCase();
      });
    } catch (cause) {
      throw new SchedulingReadError('Failed to read applicant home district', { cause });
    }
  }
}
