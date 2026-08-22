// ══════════════════════════════════════════════════════════════════
// document-forensics-service — MinIO retrieval adapter (S3 GET, SigV4)
//
// Retrieval-only S3 GetObject against MinIO, signed by the shared SigV4
// transport (minio.sigv4.ts — one signer for GET and PUT). The write half
// lives in minio.object-writer.ts behind its own port, so this class can never
// become an upload path (owner decision D3).
//
// NEW: THE ENVELOPE IS OPENED HERE. Objects written by the upload ingress are
// AES-256-GCM sealed at rest with the object path as AAD. The analyzer works
// on real bytes, so decryption belongs at the retrieval boundary and nowhere
// else — no use case, and no future adapter, ever handles ciphertext.
//
// The key is OPTIONAL and its absence is honest, not permissive:
//   • unsealed object, no key   → bytes returned verbatim (the analyze proof's
//                                 fixtures, and anything written before the
//                                 envelope existed)
//   • sealed object,   no key   → THROWS. Returning ciphertext would make the
//                                 analyzer score unreadable bytes as an
//                                 unknown container and publish a confident
//                                 AMBER lane for a document it never read.
//                                 A fabricated verdict is worse than an outage.
// ══════════════════════════════════════════════════════════════════

import { ObjectStoreUnavailableError, type ObjectStore } from '../ports/object-store.js';
import { envelopeAad, openDocument } from '../domain/document-envelope.js';
import { encodeObjectPath, s3Request } from './minio.sigv4.js';
import type { ObjectStoreConfig } from '../config.js';

export class MinioObjectStore implements ObjectStore {
  readonly #config: ObjectStoreConfig;
  readonly #envelopeKey: Buffer | undefined;

  /**
   * @param envelopeKey Derived AES key (deriveEnvelopeKey). Omit ONLY where no
   *   sealed object can exist — production composition always supplies it.
   */
  constructor(config: ObjectStoreConfig, envelopeKey?: Buffer) {
    this.#config = config;
    this.#envelopeKey = envelopeKey;
  }

  async getObject(bucket: string, key: string): Promise<Buffer | null> {
    const reply = await s3Request(
      this.#config,
      'GET',
      encodeObjectPath(bucket, key),
      Buffer.alloc(0),
    );

    if (reply.status === 404) return null; // no such key (or bucket) — absence, not a fault
    if (reply.status !== 200) {
      throw new ObjectStoreUnavailableError(
        `object store returned ${reply.status} for ${bucket}/${key}`,
      );
    }
    // Unsealed → verbatim. Sealed → authenticated decryption bound to this path.
    return openDocument(this.#envelopeKey, envelopeAad(bucket, key), reply.body);
  }
}
