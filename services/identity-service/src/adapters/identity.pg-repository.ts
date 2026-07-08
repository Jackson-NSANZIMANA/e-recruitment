// ══════════════════════════════════════════════════════════════════
// identity-service — Identity repository adapter (PostgreSQL + pgcrypto)
//
// Every operation runs in a transaction that assumes the
// `usrp_system_service` role (the app connects as the privilege-less
// `usrp_app` login and SET ROLEs per request) and sets the pgcrypto key
// as a TRANSACTION-LOCAL setting so it never leaks onto the pooled
// connection. PII columns are written through pgp_sym_encrypt — the same
// idiom proven to round-trip in the data-layer verification.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import type {
  CreateVerifiedIdentityInput,
  CreateVerifiedIdentityResult,
  IdentityRepository,
} from '../ports/identity.repository.js';
import { IdentityPersistenceError } from '../domain/identity.errors.js';

const SYSTEM_ROLE = 'usrp_system_service';
const ENCRYPTION_KEY_SETTING = 'app.encryption_key';

export class PgIdentityRepository implements IdentityRepository {
  /**
   * @param encryptionKey pgcrypto symmetric key, set per-transaction as
   *   `app.encryption_key`. Sourced from SecurityConfig (HSM/KMS in prod).
   */
  constructor(private readonly encryptionKey: string) {}

  async findIdByNationalIdHash(nationalIdHash: string): Promise<string | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const rows = await tx<{ id: string }[]>`
          SELECT id
          FROM public_core.applicant_identities
          WHERE national_id_hash = ${nationalIdHash}
            AND deleted_at IS NULL
          LIMIT 1
        `;
        const row = rows[0];
        return row ? row.id : null;
      });
    } catch (cause) {
      throw new IdentityPersistenceError('Failed to look up identity by national-id hash', { cause });
    }
  }

  async createVerifiedIdentity(
    input: CreateVerifiedIdentityInput,
  ): Promise<CreateVerifiedIdentityResult> {
    const matchConfidence =
      input.nidaMatchConfidence === null ? null : input.nidaMatchConfidence.toFixed(2);

    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        // Transaction-local (is_local = true) — key is scoped to this tx only.
        await tx`SELECT set_config(${ENCRYPTION_KEY_SETTING}, ${this.encryptionKey}, true)`;

        const inserted = await tx<{ id: string }[]>`
          INSERT INTO public_core.applicant_identities
            (national_id_hash, encrypted_full_name, encrypted_date_of_birth,
             encrypted_home_district, encrypted_home_province, encrypted_nida_lookup_hash,
             gender, registration_channel, identity_status, nida_verification_request_id,
             nida_verified_at, nida_match_confidence, phone_number_hash)
          VALUES (
            ${input.nationalIdHash},
            pgp_sym_encrypt(${input.fullName},       current_setting(${ENCRYPTION_KEY_SETTING})),
            pgp_sym_encrypt(${input.dateOfBirth},    current_setting(${ENCRYPTION_KEY_SETTING})),
            pgp_sym_encrypt(${input.homeDistrict},   current_setting(${ENCRYPTION_KEY_SETTING})),
            pgp_sym_encrypt(${input.homeProvince},   current_setting(${ENCRYPTION_KEY_SETTING})),
            pgp_sym_encrypt(${input.nidaLookupHash}, current_setting(${ENCRYPTION_KEY_SETTING})),
            ${input.gender}::public_core.gender,
            ${input.registrationChannel}::public_core.application_channel,
            'VERIFIED',
            ${input.nidaVerificationRequestId},
            now(),
            ${matchConfidence},
            ${input.phoneNumberHash}
          )
          ON CONFLICT (national_id_hash) DO NOTHING
          RETURNING id
        `;

        const insertedRow = inserted[0];
        if (insertedRow) {
          return { applicantId: insertedRow.id, created: true };
        }

        // Lost the race (or a prior run created it): resolve the existing row.
        const existing = await tx<{ id: string }[]>`
          SELECT id FROM public_core.applicant_identities
          WHERE national_id_hash = ${input.nationalIdHash}
          LIMIT 1
        `;
        const existingRow = existing[0];
        if (existingRow) {
          return { applicantId: existingRow.id, created: false };
        }

        throw new IdentityPersistenceError(
          'Insert affected no row and no existing identity was found',
        );
      });
    } catch (cause) {
      if (cause instanceof IdentityPersistenceError) throw cause;
      throw new IdentityPersistenceError('Failed to create verified identity', { cause });
    }
  }
}
