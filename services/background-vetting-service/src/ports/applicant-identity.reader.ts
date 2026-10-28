// ══════════════════════════════════════════════════════════════════
// background-vetting-service — the applicant's verified identity, for binding
//
// TRANSIENT PII: the decrypted name and date of birth are compared by the
// binding rule and discarded. They are never stored, logged or emitted.
// ══════════════════════════════════════════════════════════════════

import type { IdentityVerificationStatus } from '@usrp/shared-database';

export interface ApplicantBindingSubject {
  readonly identityStatus: IdentityVerificationStatus;
  readonly fullName: string;
  /** YYYY-MM-DD. */
  readonly dateOfBirth: string;
  readonly sex: 'MALE' | 'FEMALE';
  /** 8 digits (first 4 + last 4 of the NID), or null for identities verified before rls/0042. */
  readonly nationalIdHint: string | null;
}

export interface ApplicantIdentityReader {
  /** Null if absent or soft-deleted. */
  findBindingSubjectById(applicantId: string): Promise<ApplicantBindingSubject | null>;
}
