// ══════════════════════════════════════════════════════════════════
// background-vetting-service — the append-only verification record (rls/0040)
//
// Written only through the agency's SECURITY DEFINER command function
// record_clearance_verification. No name or date of birth can be passed: the
// reference is an HMAC plus its last 4 characters, the rest is closed codes.
// ══════════════════════════════════════════════════════════════════

import type { BindingFields } from '@usrp/shared-identity-match';
import type { Agency } from '@usrp/shared-types';

export type VerificationOutcome = 'CLEARED' | 'REVIEW' | 'CORRECTION_NEEDED' | 'PENDING';

export interface ClearanceVerificationRecord {
  readonly agency: Agency;
  readonly applicationId: string;
  /** hex HMAC-SHA256 of the normalised number under CLEARANCE_REFERENCE_HMAC_KEY. */
  readonly referenceHmac: string;
  /** The last 4 characters of the number. */
  readonly referenceLast4: string;
  readonly certificateType: string | null;
  /** ISO date or null. */
  readonly issuedOn: string | null;
  readonly outcome: VerificationOutcome;
  readonly failureCode: string | null;
  readonly reviewReasons: readonly string[];
  readonly binding: BindingFields | null;
  readonly requestId: string | null;
  readonly correlationId: string;
}

export type RecordVerificationResult = 'RECORDED' | 'ALREADY_RECORDED';

export interface ClearanceVerificationRepository {
  record(input: ClearanceVerificationRecord): Promise<RecordVerificationResult>;
}
