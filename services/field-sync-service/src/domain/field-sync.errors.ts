// ══════════════════════════════════════════════════════════════════
// field-sync-service — Domain errors (infra faults only)
//
// Business outcomes (unenrolled device, bad signature, stale write, conflict,
// unknown application) are RETURN VALUES on the use-case outcomes, not throws.
// This names the one infra fault the persistence layer can raise, so the HTTP
// adapter maps it to 5xx without leaking internals — and, crucially, so a DB
// fault mid-batch propagates (offset uncommitted / request failed) rather than
// being mistaken for a rejected record.
// ══════════════════════════════════════════════════════════════════

export class FieldSyncPersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FieldSyncPersistenceError';
  }
}
