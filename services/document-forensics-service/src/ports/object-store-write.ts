// ══════════════════════════════════════════════════════════════════
// document-forensics-service — ObjectStoreWrite port (storage ONLY)
//
// Deliberately separate from ObjectStore (retrieval). Upload ingress writes
// real bytes; retrieval reads them back for analysis. A single combined
// interface would let any future code path in this service become an
// accidental upload handler — the separation is the guardrail (owner decision
// D3), now that a legitimate writer exists.
//
// ONE ERROR CLASS, RE-EXPORTED — NOT REDECLARED. This file used to declare its
// OWN `ObjectStoreUnavailableError` with the same name as the one in
// object-store.ts. Two classes with one name are two distinct identities, so
// `err instanceof ObjectStoreUnavailableError` imported from object-store.js
// would have been FALSE for everything the writer threw: the controller's 503
// mapping would have silently degraded to 500 INTERNAL_ERROR the first time
// MinIO refused a write. A duplicated error class is not duplication, it is a
// broken catch clause — so the write port re-exports the single class.
//
// SEQUENCE INVARIANT (ADR-004): scan → verdict → store. If the scan fails or
// the bytes are infected, NOTHING is written here and no document_records row
// is created. An infected upload leaves an audit event and no artefact.
// ══════════════════════════════════════════════════════════════════

/** Store a document's bytes in the object store. */
export interface ObjectStoreWrite {
  /**
   * Write bytes at bucket/key, idempotent by key: the same (application,
   * document type) tuple always derives the same key, so a re-upload REPLACES
   * the object rather than accumulating orphans. Throws
   * ObjectStoreUnavailableError on infra faults (unreachable, auth rejected,
   * out of space) — there is no "absent" outcome for a write.
   */
  putObject(bucket: string, key: string, bytes: Buffer): Promise<void>;
}

// The SINGLE error identity for both halves of the store. See header.
export { ObjectStoreUnavailableError } from './object-store.js';
