// ══════════════════════════════════════════════════════════════════
// application-service — IdentityReader port
//
// The front door must confirm the applicant is a VERIFIED identity before
// accepting a submission (identity-service owns NIDA; we do not re-verify)
// and needs the applicant's system-wide national_id_hash to stamp onto the
// APPLICANT_SUBMITTED event. Both columns are UNENCRYPTED on
// applicant_identities — so this reader needs no pgcrypto key.
// ══════════════════════════════════════════════════════════════════

import type { IdentityVerificationStatus } from '@usrp/shared-database';

/** The identity facts the front door needs — no PII, no decryption. */
export interface ApplicantIdentitySummary {
  readonly identityStatus: IdentityVerificationStatus;
  readonly nationalIdHash: string;
}

export interface IdentityReader {
  /** Look up an applicant by id, or null if none (or soft-deleted). */
  findApplicantById(applicantId: string): Promise<ApplicantIdentitySummary | null>;
}
