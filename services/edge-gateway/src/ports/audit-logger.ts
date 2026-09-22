// ══════════════════════════════════════════════════════════════════
// edge-gateway — Audit logger port
//
// The abstract interface for structured audit logging. The application layer
// uses this to emit security-relevant events (session issued, session destroyed,
// authentication attempts) without coupling to console.log, Winston, or any
// concrete logger.
//
// Implementations: adapters/audit-logger.adapter.ts
// ══════════════════════════════════════════════════════════════════

/**
 * A structured audit event. The shape is intentionally loose (Record<string, unknown>)
 * because different events have different fields (session issued has sessionId,
 * rate limit exceeded has bucketKey, etc.). The adapter ensures all events
 * are logged as valid JSON.
 */
export interface AuditEvent extends Record<string, unknown> {
  /** The action being logged (e.g., 'EDGE_SESSION_ISSUED'). */
  readonly action: string;
  /** Operation id (e.g., 'officerLogin'). */
  readonly operationId?: string;
  /** Correlation id for distributed tracing. */
  readonly correlationId?: string;
  /** Session id (if applicable). */
  readonly sessionId?: string;
  /** Subject id (officer or applicant id). */
  readonly subjectId?: string;
  /** Agency (officer only). */
  readonly agency?: string;
  /** Session kind ('officer' | 'applicant'). */
  readonly sessionKind?: string;
  /** Timestamp (defaults to now if not provided). */
  readonly timestamp?: Date;
}

/**
 * Session statistics for periodic emission. These are aggregate counts with
 * no per-session detail, so they are safe to log and emit as metrics.
 */
export interface SessionStatsEvent {
  readonly activeOfficerSessions?: number;
  readonly activeApplicantSessions?: number;
  readonly revokedSessions?: number;
  readonly expiredSessions?: number;
  readonly rateLimitBuckets?: number;
  readonly sessionsSwept?: number;
}

/**
 * Audit logger port. The application layer uses this to emit structured logs
 * without coupling to console.log, pino, Winston, or any concrete logger.
 *
 * All events are logged as JSON (the adapter ensures this). The port does not
 * dictate log levels (info, warn, error) — the adapter decides based on the
 * event's `action` field.
 */
export interface AuditLogger {
  /**
   * Log a structured audit event. The event is serialized to JSON and emitted
   * to the configured log sink (stdout in production, file in dev).
   *
   * @param event Audit event
   */
  log(event: AuditEvent): void;

  /**
   * Log session statistics (periodic aggregate counts). Emitted every minute
   * in production for observability.
   *
   * @param stats Session statistics
   */
  logStats(stats: SessionStatsEvent): void;
}
