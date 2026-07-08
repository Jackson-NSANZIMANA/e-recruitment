// ══════════════════════════════════════════════════════════════════
// @usrp/audit-service — Public API & composition root
//
// Wires the pure audit sink (AuditWriter port) to its PostgreSQL adapter.
// The event transport is provided by the caller so tests can inject an
// InMemoryEventBus and production a KafkaEventBus (see main.ts). Unlike the
// request/response services there is no use-case object to build — the sink's
// whole behaviour is "map the event, append the record" — so the composition
// root just constructs the writer.
// ══════════════════════════════════════════════════════════════════

import { PgAuditWriter } from './adapters/audit.pg-writer.js';
import type { AuditWriter } from './ports/audit-writer.js';

/** Assemble the audit sink's persistence adapter. */
export function createAuditWriter(): AuditWriter {
  return new PgAuditWriter();
}

// ── Re-exports ────────────────────────────────────────────────────
export { PgAuditWriter } from './adapters/audit.pg-writer.js';
export { toAuditRecord } from './application/audit-event.mapper.js';
export {
  AUDIT_CONSUMER_GROUP,
  startAuditEntryConsumer,
} from './adapters/events/audit-entry.consumer.js';
export { loadAuditConfig } from './config.js';
export type { AuditServiceConfig } from './config.js';
export { AuditWriteError } from './domain/audit.errors.js';
export type {
  AppendOutcome,
  AuditRecord,
  AuditWriter,
} from './ports/audit-writer.js';
