// ══════════════════════════════════════════════════════════════════
// @usrp/shared-logging — the redaction control
//
// This is the edge-gateway's redaction, LIFTED VERBATIM and promoted to a
// shared package so there is exactly ONE definition of "what may never reach a
// log" in this system. edge-gateway/src/adapters/audit-logger.adapter.ts now
// imports from here and re-exports, so its 95-check hygiene proof keeps
// testing the same function it always did — there is no second copy to drift.
//
// WHY THE CONTROL IS STRUCTURAL, not a review convention: a National ID or a
// session handle that reaches a log is not recoverable. Logs are shipped,
// indexed, retained, and read by far more people than any database row. The
// guard has to survive a future contributor adding one convenient field to a
// line that was fine yesterday — so it runs on EVERY line, keyed on the field
// name and on the shape of the value, not on the call site's good intentions.
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
