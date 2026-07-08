// ══════════════════════════════════════════════════════════════════
// application-service — Domain errors
//
// Only infrastructure faults and truly exceptional states throw. Ordinary
// business outcomes (identity not verified, no open campaign, category not
// in the campaign) are RETURN VALUES on the use-case outcome, not throws —
// the same pattern identity-service uses. These error types name the
// infrastructure faults the repository/readers can raise, so the HTTP
// adapter can map them to 5xx without leaking internals.
// ══════════════════════════════════════════════════════════════════

/** A read against applicant identity / campaign state failed (infra fault). */
export class ApplicationReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ApplicationReadError';
  }
}

/** Persisting the application (or its status-history row) failed (infra fault). */
export class ApplicationPersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ApplicationPersistenceError';
  }
}
