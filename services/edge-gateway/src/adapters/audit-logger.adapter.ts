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

/**
 * Keys whose VALUE is never loggable, whatever the nesting depth. Matched
 * case-insensitively on a normalized key so `nationalID`, `national_id` and
 * `NationalId` are all caught.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'nationalid',
  'nationalidhash',
  'password',
  'otp',
  'token',
  'sessiontoken',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'setcookie',
  'csrf',
  'csrftoken',
  'handle',
  'upstreamcredential',
  'credential',
  'clientsecret',
  'privatekey',
  'publickeypem',
  'qrinvitationcode',
  'devicesignature',
  'idempotencykey',
]);

/** Any 16-digit run is a candidate Rwandan National ID. Masked wherever it appears. */
const NID_SHAPED = /\d{16}/g;
const REDACTED = '[redacted]';
const MAX_DEPTH = 6;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Recursively redact forbidden keys and NID-shaped digit runs. Pure; exported for proofs. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === 'string') return value.replace(NID_SHAPED, REDACTED);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = FORBIDDEN_KEYS.has(normalizeKey(key)) ? REDACTED : redact(entry, depth + 1);
  }
  return out;
}

type Sink = (line: string) => void;

/**
 * Reduce a thrown value to what an operator needs and nothing more. The message
 * is dropped on purpose: postgres.js puts parameter values in it, and an
 * upstream error can quote a response body.
 */
export function summariseError(error: unknown): { readonly name: string; readonly code: string | null } | null {
  if (error === undefined || error === null) return null;
  if (typeof error !== 'object') return { name: typeof error, code: null };
  const named = error as { name?: unknown; code?: unknown };
  return {
    name: typeof named.name === 'string' ? named.name : 'Error',
    code: typeof named.code === 'string' ? named.code : null,
  };
}

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
