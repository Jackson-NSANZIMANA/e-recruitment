// ══════════════════════════════════════════════════════════════════
// notification-service — PgContactResolver adapter (PostgreSQL + pgcrypto)
//
// The production ContactResolver (ADR-021): decrypts the stored contact
// captured at OTP verification. Reads applicant_identities as the
// usrp_system_service role (the app connects as the privilege-less usrp_app
// login and SET ROLEs per transaction) with the pgcrypto key set
// TRANSACTION-LOCAL so it never leaks onto the pooled connection — the same
// idiom identity-service writes with and eligibility-service reads with.
//
// Null semantics are deliberate: null ONLY for "nothing deliverable on
// file" (unknown applicant, no captured contact, erased row). A genuine
// fault — wrong key, connection loss — THROWS, so a decryption problem can
// never masquerade as PENDING_NO_CONTACT.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import type { ContactResolver, ResolvedContact } from '../ports/contact-resolver.js';

const SYSTEM_ROLE = 'usrp_system_service';
const ENCRYPTION_KEY_SETTING = 'app.encryption_key';

export class PgContactResolver implements ContactResolver {
  /** @param encryptionKey pgcrypto key, set per-transaction as app.encryption_key. */
  constructor(private readonly encryptionKey: string) {}

  async resolve(applicantId: string): Promise<ResolvedContact | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        await tx`SELECT set_config(${ENCRYPTION_KEY_SETTING}, ${this.encryptionKey}, true)`;

        const rows = await tx<{ phone: string }[]>`
          SELECT pgp_sym_decrypt(encrypted_phone_number::bytea, current_setting(${ENCRYPTION_KEY_SETTING})) AS phone
          FROM public_core.applicant_identities
          WHERE id = ${applicantId}
            AND deleted_at IS NULL
            AND encrypted_phone_number IS NOT NULL
          LIMIT 1
        `;

        const row = rows[0];
        if (!row) return null;
        return { channel: 'SMS', destination: row.phone };
      });
    } catch (cause) {
      throw new Error('Failed to resolve applicant contact', { cause });
    }
  }
}
