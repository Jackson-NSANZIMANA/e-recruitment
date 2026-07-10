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
