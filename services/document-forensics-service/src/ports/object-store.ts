// ══════════════════════════════════════════════════════════════════
// document-forensics-service — ObjectStore port (retrieval ONLY)
//
// The analyzer works on REAL bytes, so the service must fetch the referenced
// object. Deliberately GET-only: document upload/storage is the future
// portal slice's concern (owner decision D3) — keeping the write half out of
// this port means this service can never become an accidental upload path.
// ══════════════════════════════════════════════════════════════════

/** Retrieve a stored object's bytes for analysis. */
export interface ObjectStore {
  /**
   * Fetch the object at bucket/key. Returns the raw bytes, or null when the
   * object (or bucket) does not exist. Infra faults (store unreachable,
   * auth rejected) throw ObjectStoreUnavailableError — absence is an outcome,
   * unavailability is a fault.
   */
  getObject(bucket: string, key: string): Promise<Buffer | null>;
}

/** The object store could not be reached or refused the request. */
export class ObjectStoreUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ObjectStoreUnavailableError';
  }
}
