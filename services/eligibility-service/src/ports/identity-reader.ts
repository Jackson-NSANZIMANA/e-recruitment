// ══════════════════════════════════════════════════════════════════
// eligibility-service — IdentityReader port
//
// Eligibility needs the applicant's verified date of birth to compute the
// age gate. It reads it from the identity system-of-record through this
// port; the concrete adapter decrypts the PII column as the system
// service. The DOB is a transient secret — never stored, logged, or
// emitted by this service.
// ══════════════════════════════════════════════════════════════════

import type { IdentityVerificationStatus } from '@usrp/shared-database';

export interface ApplicantIdentityRecord {
  /** Decrypted date of birth (YYYY-MM-DD). Transient PII. */
  readonly dateOfBirth: string;
  readonly identityStatus: IdentityVerificationStatus;
}

/**
 * The minimal record the HEC degree gate needs: verification status and the
 * decrypted G2G subject hash used to bind a degree to its holder. Deliberately
 * does NOT carry the date of birth — the degree path never needs it, so this
 * read decrypts one less PII column (least exposure).
 */
export interface ApplicantG2GSubjectRecord {
  readonly identityStatus: IdentityVerificationStatus;
  /**
   * Decrypted G2G subject hash — HMAC(NIDA-shared secret, NID). Null for
   * identities created before the hash column existed (fail closed upstream).
   */
  readonly nidaLookupHash: string | null;
}

export interface IdentityReader {
  /** Read an applicant identity by id; null if absent or soft-deleted. */
  findApplicantById(applicantId: string): Promise<ApplicantIdentityRecord | null>;

  /**
   * Read the applicant's verification status + decrypted G2G subject hash;
   * null if absent or soft-deleted. Used by the HEC degree gate.
   */
  findG2GSubjectById(applicantId: string): Promise<ApplicantG2GSubjectRecord | null>;
}
