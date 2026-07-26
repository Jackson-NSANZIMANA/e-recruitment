// ══════════════════════════════════════════════════════════════════
// identity-service — ApplicantAuthRepository adapter (PostgreSQL)
//
// Runs as usrp_system_service (rls/0016 grants + FORCE'd RLS). Storage
// discipline:
//   • only DIGESTS land here — the scrypt otp_hash and the HMAC
//     phone_number_hash; the plaintext code and raw phone never reach
//     this adapter;
//   • the session token is stored verbatim (it IS the opaque credential,
//     server-side; a hash-at-rest upgrade is an ADR-018 follow-on) but is
//     never logged and never leaves via any method other than the
//     caller-supplied lookup;
//   • findLiveSession slides last_activity_at in the same statement —
//     one round trip, no read-then-write race.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { IdentityPersistenceError } from '../domain/identity.errors.js';
import type {
  ApplicantAuthRepository,
  CreateChallengeInput,
  CreateSessionInput,
  OtpChallengeRecord,
} from '../ports/applicant-auth.repository.js';

const SYSTEM_ROLE = 'usrp_system_service';

export class PgApplicantAuthRepository implements ApplicantAuthRepository {
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

  async consumeChallenge(challengeId: string): Promise<void> {
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        await tx`
          UPDATE public_core.applicant_otp_challenges
          SET consumed_at = now()
          WHERE id = ${challengeId} AND consumed_at IS NULL
        `;
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
          VALUES (${input.applicantId}, ${input.sessionToken},
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
          WHERE session_token = ${sessionToken}
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
          WHERE session_token = ${sessionToken} AND terminated_at IS NULL
        `;
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to terminate applicant session');
    }
  }

  async stampPhoneVerified(applicantId: string, phoneNumberHash: string): Promise<void> {
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        await tx`
          UPDATE public_core.applicant_identities
          SET phone_number_hash = ${phoneNumberHash}, phone_verified_at = now()
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
