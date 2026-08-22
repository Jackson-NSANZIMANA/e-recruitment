// ══════════════════════════════════════════════════════════════════
// document-forensics-service — Object key derivation (pure)
//
// THE KEY IS DERIVED, NEVER SUPPLIED. Every input is from a closed, already
// validated set: an Agency, a UUID application id, and a DocumentType the
// owning agency actually models. A key built from those three cannot contain
// '..', cannot escape its prefix, and cannot address another application's
// object — whereas a client-supplied key (or a client filename) is a path
// traversal and a write-into-someone-else's-record primitive in one field.
//
// THE KEY IS ALSO STABLE, WHICH IS A PRODUCT DECISION.
// One object per (application, document type). Re-uploading a corrected
// certificate therefore lands on the SAME key: MinIO overwrites the object and
// document_records UPDATEs the same row (it keys idempotency on
// application_id + minio_object_key). The alternative — mixing a content hash
// or a timestamp into the key — leaves the superseded object at rest forever
// under a key no row points at: unreachable, un-analyzed, and still a copy of
// a citizen's national ID.
//
// NO FILE EXTENSION, deliberately. The extension would have to come from the
// declared media type, and then a citizen who re-uploads the same certificate
// as a PDF instead of a JPEG would write to a DIFFERENT key, orphaning the
// first object and creating a second document_records row for one logical
// document. The container is identified from the bytes by the analyzer anyway,
// so the extension carries no information the system relies on.
// ══════════════════════════════════════════════════════════════════

import type { Agency, DocumentType } from '@usrp/shared-types';

/** Mirrors document_records.minio_object_key varchar(512). */
const MAX_KEY_LENGTH = 512;

/**
 * `rdf/<applicationId>/olevel_certificate`
 *
 * Throws a plain Error (a programmer bug, rendered as 500) if the result could
 * not be stored — an over-long key would fail at the DB layer with a much
 * less obvious message, after the bytes were already in MinIO.
 */
export function deriveObjectKey(
  agency: Agency,
  applicationId: string,
  documentType: DocumentType,
): string {
  const key = `${agency.toLowerCase()}/${applicationId}/${documentType.toLowerCase()}`;
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(`Derived object key exceeds ${MAX_KEY_LENGTH} characters: ${key.length}`);
  }
  return key;
}
