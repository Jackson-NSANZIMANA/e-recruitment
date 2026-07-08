// ══════════════════════════════════════════════════════════════════
// application-service — IdentityReader adapter (PostgreSQL)
//
// Reads applicant_identities as usrp_system_service (the app connects as
// the privilege-less usrp_app login and SET LOCAL ROLEs per transaction —
// the same idiom as identity-service and eligibility-service). It reads
// ONLY the two unencrypted columns the front door needs — identity_status
// and national_id_hash — so, unlike the PII readers, it sets no pgcrypto
// key. RLS lets the system service see every applicant.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import type { IdentityVerificationStatus } from '@usrp/shared-database';
import type { ApplicantIdentitySummary, IdentityReader } from '../ports/identity-reader.js';
import { ApplicationReadError } from '../domain/application.errors.js';

const SYSTEM_ROLE = 'usrp_system_service';

export class PgIdentityReader implements IdentityReader {
  async findApplicantById(applicantId: string): Promise<ApplicantIdentitySummary | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const rows = await tx<{ identity_status: IdentityVerificationStatus; national_id_hash: string }[]>`
          SELECT identity_status, national_id_hash
          FROM public_core.applicant_identities
          WHERE id = ${applicantId}
            AND deleted_at IS NULL
          LIMIT 1
        `;
        const row = rows[0];
        if (!row) return null;
        return { identityStatus: row.identity_status, nationalIdHash: row.national_id_hash };
      });
    } catch (cause) {
      throw new ApplicationReadError('Failed to read applicant identity', { cause });
    }
  }
}
