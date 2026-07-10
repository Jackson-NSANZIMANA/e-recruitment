// ══════════════════════════════════════════════════════════════════
// identity-service — Identity repository port
//
// The write side of public_core.applicant_identities. Implementations
// are responsible for the security-critical mechanics the domain must
// not know about: assuming the `usrp_system_service` role, setting the
// pgcrypto session key, and encrypting PII at rest. The domain hands
// over plaintext PII (sourced from NIDA) and receives back only an id.
// ══════════════════════════════════════════════════════════════════

import type { ApplicationChannel, Gender } from '@usrp/shared-database';

/** Plaintext identity payload; the repository encrypts PII columns. */
export interface CreateVerifiedIdentityInput {
  /** USRP-internal applicant key: HMAC(NATIONAL_ID_HMAC_KEY, NID), 64 hex. */
  readonly nationalIdHash: string;
  /**
   * G2G subject hash: HMAC(NIDA-shared secret, NID). Stored ENCRYPTED at
   * rest so G2G credential checks (HEC/RIB) can re-present it. Distinct from
   * `nationalIdHash`. Never logged.
   */
  readonly nidaLookupHash: string;
  readonly fullName: string;
  readonly dateOfBirth: string; // YYYY-MM-DD
  readonly homeDistrict: string;
  readonly homeProvince: string;
  readonly gender: Gender;
  readonly registrationChannel: ApplicationChannel;
  readonly phoneNumberHash: string | null;
  readonly nidaVerificationRequestId: string;
  readonly nidaMatchConfidence: number | null;
}

export interface CreateVerifiedIdentityResult {
  /** UUID of the applicant_identities row. */
  readonly applicantId: string;
  /** false when a row for this nationalIdHash already existed (idempotent). */
  readonly created: boolean;
}

/** The exam-day biometric outcome to record onto the identity (scores/verdict only). */
export interface RecordBiometricResultInput {
  readonly applicantId: string;
  readonly sessionId: string;
  /** Overall pass (liveness AND face match) — drives biometric_verified_at. */
  readonly verified: boolean;
  readonly passedLiveness: boolean;
  readonly faceMatchConfidence: number; // 0..100
}

export interface IdentityRepository {
  /** Return the applicant id for a national-id hash, or null if none. */
  findIdByNationalIdHash(nationalIdHash: string): Promise<string | null>;

  /**
   * Insert a VERIFIED identity with PII encrypted at rest. Idempotent on
   * `nationalIdHash`: a concurrent duplicate resolves to the existing row
   * (`created: false`) rather than raising.
   */
  createVerifiedIdentity(
    input: CreateVerifiedIdentityInput,
  ): Promise<CreateVerifiedIdentityResult>;

  /**
   * Record the exam-day biometric outcome onto the applicant identity (scores
   * and verdict only — no biometric data). Idempotent (a plain UPDATE); returns
   * 'not_found' when no such identity exists (never a silent success).
   */
  recordBiometricResult(input: RecordBiometricResultInput): Promise<'updated' | 'not_found'>;
}
