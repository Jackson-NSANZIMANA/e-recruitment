// ══════════════════════════════════════════════════════════════════
// scheduling-service — Domain errors
//
// Infrastructure faults (a DB read or write that fails) throw and PROPAGATE out
// of the consumer so the Kafka offset is left uncommitted and the event is
// retried (then dead-lettered, ADR-025) — a slot must never be silently
// skipped. Business outcomes (no venue, no seat, already assigned, applicant
// not found) are RETURN VALUES, not errors.
// ══════════════════════════════════════════════════════════════════

export class SchedulingReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SchedulingReadError';
  }
}

/** A reservation / deferral could not be durably recorded (ADR-026). */
export class SchedulingWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SchedulingWriteError';
  }
}
