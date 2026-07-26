// ══════════════════════════════════════════════════════════════════
// identity-service — Erasure repository adapter (PostgreSQL, ADR-015)
//
// Tombstone-overwrite erasure in ONE transaction as usrp_system_service
// (pc_ai_system RLS policy sees every identity row):
//
//   1. FOR UPDATE the identity row — serializes against a concurrent
//      accept (ADR-014 stamps the lock on this same row) and against a
//      concurrent erasure of the same citizen.
//   2. Gate (D2, fail-closed): refused if accept-locked (enlisted —
//      retention obligation) or if ANY application in ANY ops schema is
//      non-terminal (REJECTED / WITHDRAWN / WALK_IN_REJECTED are the
//      only terminal-for-erasure states).
//   3. Overwrite: the five encrypted_* columns → literal tombstone (the
//      original pgcrypto ciphertexts cease to exist — with no backups in
//      this tier, that IS destruction); national_id_hash → rotated
//      random value (breaks re-linkage; keeps UNIQUE NOT NULL);
//      phone/biometric/nida columns → NULL/false; deleted_at stamped.
//      ONE UPDATE, so the rls/0014 freeze trigger sees the erasure
//      stamp atomically and freezes the row from the next statement on.
//   4. DELETE the citizen's applicant_sessions rows (token, ip,
//      user-agent are personal data).
//
// The applications rows (applicant_id UUID, statuses, scores) survive:
// they are the agencies' legal-obligation processing record and carry
// no direct PII. The immutable audit/history trails survive for the
// same reason (rls/0002, 0007).
// ══════════════════════════════════════════════════════════════════

import { randomBytes } from 'node:crypto';
import { sql } from '@usrp/shared-database';
import type { Agency } from '@usrp/shared-types';
import type { EraseIdentityOutcome, ErasureRepository } from '../ports/erasure-repository.js';
import { IdentityPersistenceError } from '../domain/identity.errors.js';

const SYSTEM_ROLE = 'usrp_system_service';

/**
 * Negative-terminal statuses — an application here is over and lost.
 * WALK_IN_REJECTED is rdf_ops's walk-in rejection variant (a rejected
 * walk-in must not be denied erasure forever). ACCEPTED is deliberately
 * NOT terminal for the erasure gate: an accepted citizen is enlisted
 * personnel (retention obligation) — normally caught by the accept-lock
 * check first, and fail-closed here otherwise.
 */
const TERMINAL_STATUSES = ['REJECTED', 'WITHDRAWN', 'WALK_IN_REJECTED'] as const;

const OPS_SCHEMAS = [
  { schema: 'rdf_ops', agency: 'RDF' },
  { schema: 'rnp_ops', agency: 'RNP' },
  { schema: 'rcs_ops', agency: 'RCS' },
] as const;

/**
 * Rotated hash: 'e' + 63 random hex chars. Same length/charset as a real
 * SHA-256 hex digest (fits varchar(64), keeps UNIQUE NOT NULL satisfied)
 * but unlinkable — no NID hashes to it, and the leading 'e' marks it as
 * an erasure tombstone for operators reading the table.
 */
function rotatedHash(): string {
  return `e${randomBytes(32).toString('hex').slice(1)}`;
}

const TOMBSTONE = 'ERASED';

export class PgErasureRepository implements ErasureRepository {
  async eraseIdentity(applicantId: string): Promise<EraseIdentityOutcome> {
    try {
      return await sql.begin(async (tx): Promise<EraseIdentityOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        // 1. Lock the identity row — the single serialization point this
        // row already plays for the accept-lock (ADR-014).
        const rows = await tx<
          {
            deleted_at: string | null;
            cross_agency_locked_by_agency: Agency | null;
          }[]
        >`
          SELECT deleted_at, cross_agency_locked_by_agency
          FROM public_core.applicant_identities
          WHERE id = ${applicantId} FOR UPDATE
        `;
        const identity = rows[0];
        if (identity === undefined) return { kind: 'NOT_FOUND' };
        if (identity.deleted_at !== null) return { kind: 'ALREADY_ERASED' };

        // 2a. Enlisted citizens are retained (legal obligation, ADR-015).
        if (identity.cross_agency_locked_by_agency !== null) {
          return {
            kind: 'REFUSED_ACCEPT_LOCKED',
            lockedByAgency: identity.cross_agency_locked_by_agency,
          };
        }

        // 2b. Any in-flight application defers erasure. Checked per schema
        // (statuses are schema-local enums); first offender reported.
        for (const { schema, agency } of OPS_SCHEMAS) {
          const active = await tx<{ status: string }[]>`
            SELECT status::text AS status FROM ${tx(schema)}.applications
            WHERE applicant_id = ${applicantId}
              AND status::text NOT IN ${tx([...TERMINAL_STATUSES])}
            LIMIT 1
          `;
          const offender = active[0];
          if (offender !== undefined) {
            return { kind: 'REFUSED_ACTIVE_APPLICATION', agency, status: offender.status };
          }
        }

        // 3. The overwrite. One UPDATE: after it commits, rls/0014 freezes
        // the row against every further mutation.
        const erased = await tx`
          UPDATE public_core.applicant_identities SET
            encrypted_full_name = ${TOMBSTONE},
            encrypted_date_of_birth = ${TOMBSTONE},
            encrypted_home_district = ${TOMBSTONE},
            encrypted_home_province = ${TOMBSTONE},
            encrypted_nida_lookup_hash = NULL,
            national_id_hash = ${rotatedHash()},
            phone_number_hash = NULL,
            phone_verified_at = NULL,
            biometric_session_id = NULL,
            biometric_verified_at = NULL,
            biometric_passed_liveness = false,
            biometric_face_match_confidence = NULL,
            nida_verification_request_id = NULL,
            nida_verified_at = NULL,
            nida_match_confidence = NULL,
            deleted_at = now(),
            updated_at = now()
          WHERE id = ${applicantId} AND deleted_at IS NULL
        `;
        if (erased.count !== 1) {
          // Unreachable under the FOR UPDATE above; fail closed rather
          // than report an erasure that did not happen.
          throw new IdentityPersistenceError('Erasure UPDATE affected no row');
        }

        // 4. Session rows are personal data — hard-delete them.
        await tx`DELETE FROM public_core.applicant_sessions WHERE applicant_id = ${applicantId}`;

        return { kind: 'ERASED' };
      });
    } catch (cause) {
      if (cause instanceof IdentityPersistenceError) throw cause;
      throw new IdentityPersistenceError('Failed to erase identity', { cause });
    }
  }
}
