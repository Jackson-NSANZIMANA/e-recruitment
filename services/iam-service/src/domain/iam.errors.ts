// ══════════════════════════════════════════════════════════════════
// iam-service — Domain errors
//
// Persistence faults propagate as this typed error so the composition root /
// HTTP substrate can map an infrastructure failure (DB unreachable) to a 500,
// distinct from a business "invalid credentials" outcome (a 401 return value,
// never an exception). We never leak the underlying handle/credential.
// ══════════════════════════════════════════════════════════════════

export class IamPersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IamPersistenceError';
  }
}

/**
 * The database refused the ACTOR of an officer-admin command (ADR-036): not an
 * active agency_admin of the requested agency, or the transaction actor did
 * not match. Distinct from a business refusal (a return value): the HTTP
 * layer answers 403 and names nothing.
 */
export class OfficerAdminForbiddenError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The officer-admin actor is not an active agency administrator.', options);
    this.name = 'OfficerAdminForbiddenError';
  }
}
