// ══════════════════════════════════════════════════════════════════
// identity-service — ApplicantAuthRepository adapter (PostgreSQL)
//
// Runs as usrp_system_service (rls/0016 grants + FORCE'd RLS). Storage
// discipline:
//   • the plaintext code never reaches this adapter (scrypt otp_hash only);
//     the raw phone reaches exactly ONE method — stampPhoneVerified — and
//     is pgp_sym_encrypted in-transaction (ADR-021 stored contact), never
//     logged, never returned;
//   • the session token is stored ONLY as SHA-256(token). The bearer is 256
//     bits of CSPRNG output, so an unkeyed digest is sufficient (there is no
//     dictionary to attack) and adds no key material to manage. A database
//     read — backup, replica, any injection with system-role reach — yields
//     digests, never a working citizen session. Callers still pass the raw
//     token; the digest never leaves this adapter;
//   • consumeChallenge is a COMPARE-AND-SET: it reports whether THIS call
//     stamped consumed_at, so two concurrent verifiers holding the same valid
//     code cannot both be issued a session;
//   • findLiveSession slides last_activity_at in the same statement —
//     one round trip, no read-then-write race.
// ══════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { sql } from '@usrp/shared-database';
import { IdentityPersistenceError } from '../domain/identity.errors.js';
import type {
  ApplicantAuthRepository,
  CreateChallengeInput,
  CreateSessionInput,
  OtpChallengeRecord,
} from '../ports/applicant-auth.repository.js';

const SYSTEM_ROLE = 'usrp_system_service';
const ENCRYPTION_KEY_SETTING = 'app.encryption_key';

/**
 * The at-rest form of an applicant session bearer. Domain-separated so the
 * same token value could never collide with a digest computed for another
 * purpose. 64 hex chars — fits session_token varchar(256).
 */
function sessionTokenDigest(sessionToken: string): string {
  return createHash('sha256').update(`usrp:applicant-session:v1:${sessionToken}`, 'utf8').digest('hex');
}

export class PgApplicantAuthRepository implements ApplicantAuthRepository {
  /**
   * @param encryptionKey pgcrypto symmetric key, set per-transaction as
   * `app.encryption_key` (same discipline as PgIdentityRepository). Sourced
   * from SecurityConfig (HSM/KMS in prod).
   */
  constructor(private readonly encryptionKey: string) {}

  async findVerifiedApplicantByNidHash(nationalIdHash: string): Promise<string | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const rows = await tx<{ id: string }[]>`
          SELECT id FROM public_core.applicant_identities
          WHERE national_id_hash = ${nationalIdHash}
            AND identity_status = 'VERIFIED'::public_core.identity_verification_status
        `;
        return rows[0]?.id ?? null;
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to look up applicant identity');
    }
  }

  async createChallenge(input: CreateChallengeInput): Promise<void> {
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        await tx`
          INSERT INTO public_core.applicant_otp_challenges (applicant_id, otp_hash, expires_at)
          VALUES (${input.applicantId}, ${input.otpHash}, ${input.expiresAt.toISOString()})
        `;
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to create OTP challenge');
    }
  }

  async findLiveChallenge(applicantId: string): Promise<OtpChallengeRecord | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const rows = await tx<
          { id: string; applicant_id: string; otp_hash: string; expires_at: Date; attempts: number }[]
        >`
          SELECT id, applicant_id, otp_hash, expires_at, attempts
          FROM public_core.applicant_otp_challenges
          WHERE applicant_id = ${applicantId}
            AND consumed_at IS NULL
            AND expires_at > now()
          ORDER BY created_at DESC
          LIMIT 1
        `;
        const row = rows[0];
        if (!row) return null;
        return {
          id: row.id,
          applicantId: row.applicant_id,
          otpHash: row.otp_hash,
          expiresAt: row.expires_at,
          attempts: row.attempts,
        };
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to read OTP challenge');
    }
  }

  async recordFailedAttempt(challengeId: string): Promise<number> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const rows = await tx<{ attempts: number }[]>`
          UPDATE public_core.applicant_otp_challenges
          SET attempts = attempts + 1
          WHERE id = ${challengeId}
          RETURNING attempts
        `;
        return rows[0]?.attempts ?? 0;
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to record OTP attempt');
    }
  }

  async consumeChallenge(challengeId: string): Promise<boolean> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        // Compare-and-set. Row-level locking serialises concurrent UPDATEs on
        // the same row; the loser re-evaluates `consumed_at IS NULL` after the
        // winner commits, matches nothing, and RETURNING yields zero rows.
        // Expiry is re-checked here too: the code may have been verified a
        // hair before expiry but must not be consumed after it.
        const rows = await tx<{ id: string }[]>`
          UPDATE public_core.applicant_otp_challenges
          SET consumed_at = now()
          WHERE id = ${challengeId}
            AND consumed_at IS NULL
            AND expires_at > now()
          RETURNING id
        `;
        return rows.length === 1;
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to consume OTP challenge');
    }
  }

  async createSession(input: CreateSessionInput): Promise<void> {
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        await tx`
          INSERT INTO public_core.applicant_sessions
            (applicant_id, session_token, channel, expires_at)
          VALUES (${input.applicantId}, ${sessionTokenDigest(input.sessionToken)},
                  ${input.channel}::public_core.application_channel, ${input.expiresAt.toISOString()})
        `;
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to create applicant session');
    }
  }

  async findLiveSession(sessionToken: string): Promise<{ readonly applicantId: string } | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        // Validate + slide activity in one statement (no read-then-write race).
        const rows = await tx<{ applicant_id: string }[]>`
          UPDATE public_core.applicant_sessions
          SET last_activity_at = now()
          WHERE session_token = ${sessionTokenDigest(sessionToken)}
            AND terminated_at IS NULL
            AND expires_at > now()
          RETURNING applicant_id
        `;
        const row = rows[0];
        return row ? { applicantId: row.applicant_id } : null;
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to read applicant session');
    }
  }

  async terminateSession(sessionToken: string): Promise<void> {
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        await tx`
          UPDATE public_core.applicant_sessions
          SET terminated_at = now()
          WHERE session_token = ${sessionTokenDigest(sessionToken)} AND terminated_at IS NULL
        `;
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to terminate applicant session');
    }
  }

  async stampPhoneVerified(
    applicantId: string,
    phoneNumberHash: string,
    rawPhoneNumber: string,
  ): Promise<void> {
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        // Transaction-local (is_local = true) — key is scoped to this tx only.
        await tx`SELECT set_config(${ENCRYPTION_KEY_SETTING}, ${this.encryptionKey}, true)`;
        await tx`
          UPDATE public_core.applicant_identities
          SET phone_number_hash = ${phoneNumberHash},
              phone_verified_at = now(),
              encrypted_phone_number = pgp_sym_encrypt(${rawPhoneNumber}, current_setting(${ENCRYPTION_KEY_SETTING}))
          WHERE id = ${applicantId}
        `;
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to stamp phone verification');
    }
  }
}

function wrap(cause: unknown, message: string): IdentityPersistenceError {
  return cause instanceof IdentityPersistenceError
    ? cause
    : new IdentityPersistenceError(message, { cause });
}
