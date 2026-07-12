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
