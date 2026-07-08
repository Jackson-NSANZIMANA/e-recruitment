// ══════════════════════════════════════════════════════════════════
// eligibility-service — NESA domain model
//
// The domain's shape for an A-Level results lookup, decoupled from NESA's
// wire format. The adapter translates the external representation into
// these types so the application core never depends on NESA's HTTP
// contract. Every result carries the `nesaRequestId` so the verification
// is traceable back to the exact G2G call in both systems' audit logs.
// ══════════════════════════════════════════════════════════════════

import type { NESAVerifiedPayload } from '@usrp/shared-types';

/**
 * Outcome of a NESA A-Level results lookup by examination index number.
 * FOUND carries the verified results payload; NOT_FOUND is a business
 * outcome (no candidate for that index), not an infrastructure fault.
 */
export type NesaLookupResult =
  | {
      readonly status: 'FOUND';
      readonly nesaRequestId: string;
      readonly payload: NESAVerifiedPayload;
    }
  | {
      readonly status: 'NOT_FOUND';
      readonly nesaRequestId: string;
    };

/**
 * NESA could not be reached, timed out, or returned a non-2xx / malformed
 * response. An infrastructure fault — never a statement about the
 * candidate. Carries the `nesaRequestId` for cross-system tracing.
 */
export class NesaUnavailableError extends Error {
  constructor(
    message: string,
    readonly nesaRequestId: string,
  ) {
    super(message);
    this.name = 'NesaUnavailableError';
  }
}
