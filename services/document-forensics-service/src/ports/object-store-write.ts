// ══════════════════════════════════════════════════════════════════
// document-forensics-service — ObjectStoreWrite port (storage ONLY)
//
// Deliberately separate from ObjectStore (retrieval). Upload ingress writes
// real bytes; retrieval reads them later. A single combined interface would
// tempt this service toward becoming an accidental upload handler. The
// separation is a design guardrail (owner decision D3).
//
// The write is IDEMPOTENT by design: same (applicationId, objectKey) tuple
// produces the same stored object, idempotent by the object system's nature.
// Scan → verdict → storage is the sequence: if scan fails or the bytes are
// infected, nothing lands in MinIO and no document_records row is created.
// ══════════════════════════════════════════════════════════════════

/** Store a document's bytes in the object store. */
export interface ObjectStoreWrite {
  /**
   * Write real bytes to the object store, idempotent by key. Returns the
   * object key used for storage, or throws ObjectStoreUnavailableError on
   * infra faults (store unreachable, auth rejected, disk full). The key is
   * always derivable from (applicationId, documentType) so callers can
   * predict it; passing it explicitly makes idempotency and audit trails
   * explicit and auditable.
   */
  putObject(bucket: string, key: string, bytes: Buffer): Promise<void>;
}

/** The object store could not be reached or refused the write. */
export class ObjectStoreUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ObjectStoreUnavailableError';
  }
}
