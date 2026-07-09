// ══════════════════════════════════════════════════════════════════
// scheduling-service — Domain errors
//
// Infrastructure faults (a DB read that fails) throw and PROPAGATE out of the
// consumer so the Kafka offset is left uncommitted and the event is redelivered
// — a slot must never be silently skipped. Business outcomes (no venue for the
// district, applicant not found) are RETURN VALUES, not errors.
// ══════════════════════════════════════════════════════════════════

export class SchedulingReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SchedulingReadError';
  }
}
