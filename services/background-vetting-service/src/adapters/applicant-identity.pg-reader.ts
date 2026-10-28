// ══════════════════════════════════════════════════════════════════
// background-vetting-service — ApplicantIdentityReader (PostgreSQL + pgcrypto)
//
// Reads applicant_identities as `usrp_system_service` (RLS lets the system
// service see every applicant) and decrypts the binding columns with the
// pgcrypto key set TRANSACTION-LOCAL, so it never leaks onto the pooled
// connection. Same idiom as eligibility-service's reader.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import type { IdentityVerificationStatus } from '@usrp/shared-database';
import type { ApplicantBindingSubject, ApplicantIdentityReader } from '../ports/applicant-identity.reader.js';

const SYSTEM_ROLE = 'usrp_system_service';
const KEY_SETTING = 'app.encryption_key';

export class IdentityReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IdentityReadError';
  }
}

export class PgApplicantIdentityReader implements ApplicantIdentityReader {
  constructor(private readonly encryptionKey: string) {}

  async findBindingSubjectById(applicantId: string): Promise<ApplicantBindingSubject | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        await tx`SELECT set_config(${KEY_SETTING}, ${this.encryptionKey}, true)`;
        const rows = await tx<{ full_name: string; date_of_birth: string; gender: 'MALE' | 'FEMALE'; national_id_hint: string | null; identity_status: IdentityVerificationStatus }[]>`
          SELECT
            pgp_sym_decrypt(encrypted_full_name::bytea, current_setting(${KEY_SETTING})) AS full_name,
            pgp_sym_decrypt(encrypted_date_of_birth::bytea, current_setting(${KEY_SETTING})) AS date_of_birth,
            gender,
            CASE
              WHEN encrypted_national_id_hint IS NULL THEN NULL
              ELSE pgp_sym_decrypt(encrypted_national_id_hint::bytea, current_setting(${KEY_SETTING}))
            END AS national_id_hint,
            identity_status
          FROM public_core.applicant_identities
          WHERE id = ${applicantId}
            AND deleted_at IS NULL
          LIMIT 1
        `;
        const row = rows[0];
        if (!row) return null;
        return { identityStatus: row.identity_status, fullName: row.full_name, dateOfBirth: row.date_of_birth, sex: row.gender, nationalIdHint: row.national_id_hint };
      });
    } catch (cause) {
      throw new IdentityReadError('Failed to read the applicant binding subject', { cause });
    }
  }
}
