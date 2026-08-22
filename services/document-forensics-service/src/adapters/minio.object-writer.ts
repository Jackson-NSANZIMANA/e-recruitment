// ══════════════════════════════════════════════════════════════════
// document-forensics-service — MinIO write adapter (S3 PUT, SigV4)
//
// The document ingress. Bytes arrive already SCANNED and CLEAN — the use case
// enforces ADR-004's scan-before-store, so this adapter is only ever reached
// for a document that passed. It never decides anything.
//
// EVERY OBJECT IS SEALED BEFORE IT LEAVES THIS PROCESS. AES-256-GCM, with the
// object path as additional authenticated data, so a stored blob is valid only
// at the key it was written to (see document-envelope.ts). MinIO therefore
// never holds a readable copy of a citizen's national ID, and an operator with
// bucket access does not have documents.
//
// The key is REQUIRED here, unlike the read side: a writer that could silently
// store plaintext is exactly the failure mode the envelope exists to prevent,
// and "encryption was accidentally off in production" is not a state this
// service is permitted to reach.
// ══════════════════════════════════════════════════════════════════

import {
  ObjectStoreUnavailableError,
  type ObjectStoreWrite,
} from '../ports/object-store-write.js';
import { envelopeAad, sealDocument } from '../domain/document-envelope.js';
import { encodeObjectPath, s3Request } from './minio.sigv4.js';
import type { ObjectStoreConfig } from '../config.js';

/** MinIO answers a successful PUT with 200; 201/204 are accepted for parity. */
const WRITE_OK: ReadonlySet<number> = new Set([200, 201, 204]);

export class MinioObjectWriter implements ObjectStoreWrite {
  readonly #config: ObjectStoreConfig;
  readonly #envelopeKey: Buffer;

  constructor(config: ObjectStoreConfig, envelopeKey: Buffer) {
    this.#config = config;
    this.#envelopeKey = envelopeKey;
  }

  async putObject(bucket: string, key: string, bytes: Buffer): Promise<void> {
    const sealed = sealDocument(this.#envelopeKey, envelopeAad(bucket, key), bytes);
    const reply = await s3Request(
      this.#config,
      'PUT',
      encodeObjectPath(bucket, key),
      sealed,
    );
    if (!WRITE_OK.has(reply.status)) {
      throw new ObjectStoreUnavailableError(
        `object store refused the write with ${reply.status} for ${bucket}/${key}`,
      );
    }
  }
}
