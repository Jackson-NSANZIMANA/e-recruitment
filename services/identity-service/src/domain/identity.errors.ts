// ══════════════════════════════════════════════════════════════════
// identity-service — Domain & infrastructure errors
//
// Distinguishes *infrastructure faults* (thrown — the request cannot be
// completed and should be retried/alerted) from *business outcomes*
// (NOT_FOUND, NON_CITIZEN, ALREADY_EXISTS) which are modelled as return
// values, not exceptions. `InvalidNationalIdError` (malformed NID) is
// re-exported from shared-security so callers catch one symbol.
// ══════════════════════════════════════════════════════════════════

export { InvalidNationalIdError } from '@usrp/shared-security';

/**
 * NIDA could not be reached, timed out, or returned a non-2xx / malformed
 * response. An infrastructure fault — never a statement about the citizen.
 * Carries the `nidaRequestId` for cross-system tracing; never the raw NID.
 */
export class NidaUnavailableError extends Error {
  constructor(
    message: string,
    readonly nidaRequestId: string,
  ) {
    super(message);
    this.name = 'NidaUnavailableError';
  }
}

/** The database rejected or could not complete the identity write. */
export class IdentityPersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IdentityPersistenceError';
  }
}
