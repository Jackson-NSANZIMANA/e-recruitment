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

export interface IdentityReader {
  /** Read an applicant identity by id; null if absent or soft-deleted. */
  findApplicantById(applicantId: string): Promise<ApplicantIdentityRecord | null>;
}
