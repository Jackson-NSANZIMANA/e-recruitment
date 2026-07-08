// ══════════════════════════════════════════════════════════════════
// eligibility-service — HEC domain model
//
// The domain's shape for a degree/diploma verification, decoupled from
// HEC's wire format. The adapter translates the external representation
// into these types so the application core never depends on HEC's HTTP
// contract. Every result carries the `hecRequestId` for cross-system
// traceability. Because HEC verifies BOTH the credential and that it
// belongs to the holder (matched by the G2G subject hash), a mismatch is
// a distinct business outcome, not a "not found".
// ══════════════════════════════════════════════════════════════════

import type { HECVerifiedPayload } from '@usrp/shared-types';

/**
 * Outcome of an HEC degree/diploma verification.
 *  - VERIFIED: the credential exists AND belongs to this applicant.
 *  - HOLDER_MISMATCH: the registration exists but is registered to a
 *    different citizen — a fraud/identity signal, never eligible.
 *  - NOT_FOUND: no such registration number.
 * HOLDER_MISMATCH and NOT_FOUND are business outcomes, not faults.
 */
export type HecLookupResult =
  | {
      readonly status: 'VERIFIED';
      readonly hecRequestId: string;
      readonly payload: HECVerifiedPayload;
    }
  | { readonly status: 'HOLDER_MISMATCH'; readonly hecRequestId: string }
  | { readonly status: 'NOT_FOUND'; readonly hecRequestId: string };

/**
 * HEC could not be reached, timed out, or returned a non-2xx / malformed
 * response. An infrastructure fault — never a statement about the degree.
 */
export class HecUnavailableError extends Error {
  constructor(
    message: string,
    readonly hecRequestId: string,
  ) {
    super(message);
    this.name = 'HecUnavailableError';
  }
}
