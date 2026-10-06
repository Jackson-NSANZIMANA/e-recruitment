// ══════════════════════════════════════════════════════════════════
// edge-gateway — Audit logger adapter (structured stdout, redacted)
//
// EVERY EDGE-OWNED LINE PASSES THROUGH redact(): audit records, stats and
// operational faults alike. (The process start/stop lines in main.ts carry no
// request data and are the only other writers; verify-edge-hygiene.ts pins that.)
// Not because the call sites are careless,
// but because a National ID or a session handle reaching a log is not
// recoverable: logs are shipped, indexed, retained and read by more people than
// any database. A structural guard is the only control that survives a future
// contributor adding one convenient field.
//
// This is the ONE audit sink. It replaces two: src/observability/audit-log.ts
// (recursive, NID-aware redaction — kept, moved here) and the former version of
// this file, whose `redact` only blanked caller-named top-level fields and
// which guards.ts used, so every session/CSRF/rate-limit rejection line was
// written UNREDACTED.
// ══════════════════════════════════════════════════════════════════

import type { AuditLogger, EdgeAuditRecord, EdgeFaultRecord } from '../ports/audit-logger.js';

// The redaction control itself now lives in @usrp/shared-logging so the WHOLE
// system shares ONE definition of what may never reach a log. It was invented
// here; it is imported and re-exported unchanged, so every existing importer
// (and verify-edge-hygiene.ts, which drives StdoutAuditLogger) sees no change.
import { redact, summariseError } from '@usrp/shared-logging';

export { redact, summariseError };

type Sink = (line: string) => void;

export class StdoutAuditLogger implements AuditLogger {
  readonly #sink: Sink;
  readonly #faultSink: Sink;
  readonly #now: () => Date;

  constructor(
    sink: Sink = (line) => { console.log(line); },
    now: () => Date = () => new Date(),
    faultSink: Sink = (line) => { console.error(line); },
  ) {
    this.#sink = sink;
    this.#now = now;
    this.#faultSink = faultSink;
  }

  log(record: EdgeAuditRecord): void {
    const redacted = redact(record) as Record<string, unknown>;
    this.#sink(JSON.stringify({ msg: 'edge_audit', at: this.#now().toISOString(), ...redacted }));
  }

  stats(counters: Readonly<Record<string, number>>): void {
    // Counters are numbers by type; redact anyway so a future string field
    // cannot become the one unguarded line.
    const redacted = redact(counters) as Record<string, unknown>;
    this.#sink(JSON.stringify({ msg: 'edge_stats', at: this.#now().toISOString(), ...redacted }));
  }

  fault(record: EdgeFaultRecord, error?: unknown): void {
    const redacted = redact({ ...record, error: summariseError(error) }) as Record<string, unknown>;
    this.#faultSink(JSON.stringify({ msg: 'edge_fault', at: this.#now().toISOString(), ...redacted }));
  }
}

export function createAuditLogger(): AuditLogger {
  return new StdoutAuditLogger();
}
