// identity-service — the citizen's OWN verified identity, for the apply-wizard pre-fill (ADR-049 / ADR-FE-019).
// Reads as usrp_system_service with the pgcrypto key transaction-local, the same idiom as the other readers.
// ALLOWLIST: it selects only the fields the citizen is shown. Photo, signature, parents' names and the
// National ID are never selected, so they cannot reach a response however the layers above change.
import { sql } from '@usrp/shared-database';

export interface OwnIdentityView {
  readonly fullName: string;
  readonly sex: 'MALE' | 'FEMALE';
  readonly dateOfBirth: string;
  readonly homeDistrict: string;
  readonly homeProvince: string;
  readonly identityStatus: string;
}

export interface OwnIdentityReader {
  read(applicantId: string): Promise<OwnIdentityView | null>;
}

const KEY_SETTING = 'app.encryption_key';

export class PgOwnIdentityReader implements OwnIdentityReader {
  constructor(private readonly encryptionKey: string) {}

  async read(applicantId: string): Promise<OwnIdentityView | null> {
    return sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_system_service`;
      await tx`SELECT set_config(${KEY_SETTING}, ${this.encryptionKey}, true)`;
      const rows = await tx<{ full_name: string; date_of_birth: string; gender: 'MALE' | 'FEMALE'; home_district: string; home_province: string; identity_status: string }[]>`
        SELECT pgp_sym_decrypt(encrypted_full_name::bytea, current_setting(${KEY_SETTING})) AS full_name,
               pgp_sym_decrypt(encrypted_date_of_birth::bytea, current_setting(${KEY_SETTING})) AS date_of_birth,
               gender,
               pgp_sym_decrypt(encrypted_home_district::bytea, current_setting(${KEY_SETTING})) AS home_district,
               pgp_sym_decrypt(encrypted_home_province::bytea, current_setting(${KEY_SETTING})) AS home_province,
               identity_status::text AS identity_status
        FROM public_core.applicant_identities
        WHERE id = ${applicantId} AND deleted_at IS NULL
        LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) return null;
      return { fullName: row.full_name, sex: row.gender, dateOfBirth: row.date_of_birth, homeDistrict: row.home_district, homeProvince: row.home_province, identityStatus: row.identity_status };
    });
  }
}
