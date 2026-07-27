// ══════════════════════════════════════════════════════════════════
// identity-service — ApplicantAuthRepository port (ADR-018)
//
// The persistence seam of citizen authentication: OTP challenges
// (public_core.applicant_otp_challenges, rls/0016) and opaque DB sessions
// (public_core.applicant_sessions — owner D5: revocable rows, not JWTs).
// All methods run as usrp_system_service. Plaintext codes never cross this
// port (the caller hashes them). The raw phone crosses it exactly once —
// stampPhoneVerified — to be pgcrypto-encrypted in-transaction for
// invitation delivery (ADR-021); it is never logged and never returned.
// ══════════════════════════════════════════════════════════════════

import type { ApplicationChannel } from '@usrp/shared-types';

export interface OtpChallengeRecord {
  readonly id: string;
  readonly applicantId: string;
  /** scrypt digest of the 6-digit code. */
  readonly otpHash: string;
  readonly expiresAt: Date;
  readonly attempts: number;
}

export interface CreateChallengeInput {
  readonly applicantId: string;
  readonly otpHash: string;
  readonly expiresAt: Date;
}

export interface CreateSessionInput {
  readonly applicantId: string;
  /** The opaque bearer — crypto-random, unique, never logged. */
  readonly sessionToken: string;
  readonly channel: ApplicationChannel;
  readonly expiresAt: Date;
}

export interface ApplicantAuthRepository {
  /** The applicant's id iff a VERIFIED identity exists for this NID hash. */
  findVerifiedApplicantByNidHash(nationalIdHash: string): Promise<string | null>;

  createChallenge(input: CreateChallengeInput): Promise<void>;

  /** Newest unconsumed, unexpired challenge for the applicant, if any. */
  findLiveChallenge(applicantId: string): Promise<OtpChallengeRecord | null>;

  /** Count a failed guess; returns the post-increment attempt count. */
  recordFailedAttempt(challengeId: string): Promise<number>;

  /** Single-use: stamp consumed_at so the code can never verify twice. */
  consumeChallenge(challengeId: string): Promise<void>;

  createSession(input: CreateSessionInput): Promise<void>;

  /**
   * The applicant behind a live (unexpired, unterminated) session token —
   * sliding last_activity_at as a side effect. Null for anything else.
   */
  findLiveSession(sessionToken: string): Promise<{ readonly applicantId: string } | null>;

  /** Revoke a session (logout / administrative kill). Idempotent. */
  terminateSession(sessionToken: string): Promise<void>;

  /**
   * Stamp phone_number_hash + phone_verified_at + the encrypted stored
   * contact (ADR-021) after a successful OTP. Re-stamping overwrites, so a
   * changed NIDA phone is absorbed on the next login.
   */
  stampPhoneVerified(
    applicantId: string,
    phoneNumberHash: string,
    rawPhoneNumber: string,
  ): Promise<void>;
}
