// ══════════════════════════════════════════════════════════════════
// edge-gateway — Structured audit + redaction
//
// WHY THE EDGE DOES NOT PUBLISH AUDIT_ENTRY EVENTS.
//
// Every business action the edge brokers is ALREADY audited by the service that
// performs it, from the same `x-correlation-id` this tier forwards —
// iam-service emits OFFICER_LOGIN_SUCCEEDED, application-service emits every
// transition. A second author of the same event produces two records of one
// action that can disagree, and the disagreement would be the edge's, which is
// the tier furthest from the decision. It would also make the browser boundary
// depend on a Kafka broker being up: a bus outage would take down login for
// every officer in the country to preserve a duplicate record.
//
// So the edge audits exactly the events NO upstream can see — the lifecycle of
// the browser boundary itself — as structured lines on stdout, which is the
// same transport every other service's access log already uses and which the
// platform's log pipeline already collects.
//
// EVERY LINE PASSES THROUGH redact(). Not because the call sites are careless,
// but because a National ID or a session handle reaching a log is not
// recoverable: logs are shipped, indexed, retained and read by more people than
// any database. A structural guard is the only control that survives a future
// contributor adding one convenient field.
// ══════════════════════════════════════════════════════════════════

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
]);

/** Any 16-digit run is a candidate Rwandan National ID. Masked wherever it appears. */
const NID_SHAPED = /\d{16}/g;
const REDACTED = '[redacted]';
const MAX_DEPTH = 6;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

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

/** The closed vocabulary of edge-owned audit events. */
export type EdgeAuditAction =
  | 'EDGE_SESSION_ISSUED'
  | 'EDGE_SESSION_REFRESHED'
  | 'EDGE_SESSION_DESTROYED'
  | 'EDGE_SESSION_REJECTED'
  | 'EDGE_CSRF_REJECTED'
  | 'EDGE_RATE_LIMITED'
  | 'EDGE_WRONG_SESSION_KIND'
  | 'EDGE_UPSTREAM_UNAVAILABLE'
  | 'EDGE_FORBIDDEN_FIELD_REJECTED';

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
  readonly detail?: Record<string, unknown>;
}

export function auditEdge(record: EdgeAuditRecord): void {
  console.log(JSON.stringify({ msg: 'edge_audit', ...(redact(record) as object) }));
}

/** Aggregate, PII-free operational counters. Emitted on a timer by main(). */
export function auditEdgeStats(stats: Record<string, number>): void {
  console.log(JSON.stringify({ msg: 'edge_stats', ...stats }));
}
