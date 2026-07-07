// ══════════════════════════════════════════════════════════════════
// eligibility-service — Domain & infrastructure errors
//
// As in the identity-service template: business outcomes
// (APPLICANT_NOT_FOUND, IDENTITY_NOT_VERIFIED) are modelled as return
// values, not exceptions. Only malformed input and infrastructure faults
// throw.
// ══════════════════════════════════════════════════════════════════

/** Malformed date-of-birth reaching the age rules (should be caught upstream). */
export class InvalidDateOfBirthError extends Error {
  constructor(detail: string) {
    super(`Invalid date of birth: ${detail}`);
    this.name = 'InvalidDateOfBirthError';
  }
}

/** The identity store could not be read (connection/decrypt fault). */
export class EligibilityReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EligibilityReadError';
  }
}
