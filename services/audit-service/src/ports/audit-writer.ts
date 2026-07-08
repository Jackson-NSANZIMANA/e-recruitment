// ══════════════════════════════════════════════════════════════════
// audit-service — AuditWriter port (the domain boundary)
//
// The audit-service is a PURE EVENT SINK: it has no business HTTP surface
// and makes no decisions. Its single responsibility is to durably append
// every AUDIT_ENTRY event to the immutable audit_log — the forensic ground
// truth for any dispute under Law N° 058/2021.
//
// The port speaks in terms of the domain record (below), not Postgres or
// Kafka, so the append logic stays framework-agnostic and the persistence
// technology is swappable at the adapter.
// ══════════════════════════════════════════════════════════════════

/**
 * A single audit record ready to be appended to the immutable trail.
 * Mirrors the audit_log.audit_entries columns, derived from an AuditEvent
 * plus its Kafka envelope. Contains references and derived facts only —
 * NEVER raw PII (no name, DOB, NID). That invariant is upheld upstream by
 * the producers and re-asserted by the self-check.
 */
export interface AuditRecord {
  /** The source Kafka event id — the idempotency/dedupe key (UNIQUE in DB). */
  readonly kafkaEventId: string;
  readonly correlationId: string;
  readonly causationId: string | null;

  readonly entityType: string;
  readonly entityId: string;
  readonly agency: string;
  readonly action: string;

  readonly performedBy: string;
  readonly performedByRole: string | null;

  readonly previousStatus: string | null;
  readonly newStatus: string | null;

  readonly ipAddress: string | null;
  readonly userAgent: string | null;

  readonly metadata: Record<string, unknown> | null;

  /** Source-of-truth timestamp: when the audited action actually occurred. */
  readonly occurredAt: string;
}

/**
 * The result of an append: `inserted` for a new row, `duplicate` when the
 * event was already recorded (at-least-once delivery re-delivered it). Both
 * are success — the trail is in the correct state either way.
 */
export type AppendOutcome = 'inserted' | 'duplicate';

export interface AuditWriter {
  /**
   * Append one audit record. MUST be idempotent on `kafkaEventId`:
   * re-appending an already-recorded event leaves the trail unchanged and
   * returns 'duplicate' rather than throwing or duplicating history.
   */
  append(record: AuditRecord): Promise<AppendOutcome>;
}
