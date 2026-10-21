// ══════════════════════════════════════════════════════════════════
// biometric-service — Domain errors (infra faults only)
//
// Business outcomes (invalid QR, agency mismatch) are RETURN VALUES on the
// use-case outcome, not throws. This names the one infra fault the matcher
// can raise, so the HTTP adapter maps it to 5xx without leaking internals.
// ══════════════════════════════════════════════════════════════════

export class BiometricMatchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BiometricMatchError';
  }
}

/**
 * A reference source that has no authorisation or lawful basis was asked to
 * match (ADR-037 §2: NIDA_PORTRAIT fails closed). Not an outage: a refusal.
 */
export class ReferenceSourceNotAuthorisedError extends Error {
  constructor(readonly source: string) {
    super(`Reference source ${source} is not authorised`);
    this.name = 'ReferenceSourceNotAuthorisedError';
  }
}

/** The evidence store failed (infrastructure fault, → 500). */
export class EvidencePersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EvidencePersistenceError';
  }
}
