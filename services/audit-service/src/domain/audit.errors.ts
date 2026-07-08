// ══════════════════════════════════════════════════════════════════
// audit-service — Infrastructure errors
//
// The audit sink makes no business decisions, so it has no business-outcome
// error types — only infrastructure faults. A write that fails MUST throw so
// the Kafka consumer does NOT commit the offset: the event will be redelivered
// and re-appended (idempotently). Silently swallowing a write failure would
// drop a forensic record — the one thing this service must never do.
// ══════════════════════════════════════════════════════════════════

/** The database rejected or could not complete the audit append. */
export class AuditWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuditWriteError';
  }
}
