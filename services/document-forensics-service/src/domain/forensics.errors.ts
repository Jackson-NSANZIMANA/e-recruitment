// ══════════════════════════════════════════════════════════════════
// document-forensics-service — Domain errors
// ══════════════════════════════════════════════════════════════════

/** A durable-state fault while recording a verdict (wraps the DB cause). */
export class ForensicsPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ForensicsPersistenceError';
  }
}
