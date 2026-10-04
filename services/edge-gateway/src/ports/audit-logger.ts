// ══════════════════════════════════════════════════════════════════
// edge-gateway — Audit logger port
//
// WHY THE EDGE DOES NOT PUBLISH AUDIT_ENTRY EVENTS.
//
// Every business action the edge brokers is ALREADY audited by the service that
// performs it, from the same `x-correlation-id` this tier forwards. A second
// author of the same event produces two records of one action that can
// disagree, and the edge is the tier furthest from the decision. It would also
// make the browser boundary depend on a Kafka broker: a bus outage would take
// down login for every officer in the country to preserve a duplicate record.
//
// So the edge audits exactly the events NO upstream can see — the lifecycle of
// the browser boundary itself — as structured stdout lines, collected by the
// same pipeline as every other service's access log.
//
// THE VOCABULARY IS CLOSED. Before the homogenisation there were two loggers:
// guards.ts wrote through an adapter that did NO redaction, while the
// controllers wrote through one that did. The port now fixes the record shape,
// and the single adapter redacts every line structurally.
//
// Implementation: adapters/audit-logger.adapter.ts
// ══════════════════════════════════════════════════════════════════

/** The closed vocabulary of edge-owned audit events. */
export type EdgeAuditAction =
  | 'EDGE_SESSION_ISSUED'
  | 'EDGE_SESSION_REFRESHED'
  | 'EDGE_SESSION_DESTROYED'
  | 'EDGE_SESSION_REJECTED'
  | 'EDGE_CSRF_REJECTED'
  | 'EDGE_RATE_LIMITED'
  | 'EDGE_RATE_LIMITER_UNAVAILABLE'
  | 'EDGE_WRONG_SESSION_KIND'
  | 'EDGE_UPSTREAM_UNAVAILABLE'
  | 'EDGE_FORBIDDEN_FIELD_REJECTED'
  | 'EDGE_IDEMPOTENT_REPLAY'
  | 'EDGE_IDEMPOTENCY_KEY_REUSED';

/**
 * The closed vocabulary of OPERATIONAL faults: things that went wrong inside the
 * edge that an operator must see, but that are not boundary events. These used
 * to be raw console.error calls, which bypassed redaction entirely (a postgres
 * error message can carry bound parameter values). They now go through the same
 * redacting sink, and the error itself is reduced to its name and code.
 */
export type EdgeFaultEvent =
  | 'EDGE_LOGIN_TOKEN_UNVERIFIABLE'
  | 'EDGE_APPLICANT_UPSTREAM_REVOKE_FAILED'
  | 'EDGE_SESSION_CREDENTIAL_UNDECRYPTABLE'
  | 'EDGE_SESSION_SWEEP_FAILED'
  | 'EDGE_RATE_LIMITER_SWEEP_FAILED'
  | 'EDGE_STATS_FAILED';

export interface EdgeFaultRecord {
  readonly event: EdgeFaultEvent;
  readonly correlationId?: string;
  /** Opaque edge session id only. */
  readonly sessionId?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface EdgeAuditRecord {
  readonly action: EdgeAuditAction;
  readonly operationId?: string;
  readonly correlationId: string;
  /** Opaque ids only: an officer UUID or an edge session id. Never a name. */
  readonly sessionId?: string;
  readonly subjectId?: string;
  readonly agency?: string;
  readonly sessionKind?: string;
  readonly reason?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface AuditLogger {
  /** One boundary event. The adapter redacts structurally before it is written. */
  log(record: EdgeAuditRecord): void;
  /** Aggregate, PII-free operational counters, emitted on a timer by main(). */
  stats(counters: Readonly<Record<string, number>>): void;
  /**
   * One operational fault. `error` is summarised to { name, code } and never
   * serialised whole: messages and stacks are where bound SQL values and
   * upstream bodies hide.
   */
  fault(record: EdgeFaultRecord, error?: unknown): void;
}
