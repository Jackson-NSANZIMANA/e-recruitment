// ══════════════════════════════════════════════════════════════════
// document-forensics-service — Document-at-rest envelope (AES-256-GCM)
//
// MINIO_ENCRYPTION_KEY has existed in .env.example since the beginning,
// promising "AES-256-GCM key for document encryption (in production: HSM)",
// and NOTHING READ IT. Same class of bug as the PORT_* variables: a documented
// control that does not exist. Without this module, scanned national IDs and
// birth certificates land at rest in MinIO in plaintext.
//
// WHY NOT SSE-C (server-side encryption with customer keys)?
// MinIO REFUSES SSE-C over plain HTTP, and dev runs MINIO_USE_SSL=false. SSE-C
// would therefore be encryption that works in production and breaks every
// developer machine and every proof — which is precisely how encryption ends
// up switched off "just for local". An application-level envelope behaves
// identically on HTTP and HTTPS, keeps the key under our control (HSM/KMS in
// production), and requires no MinIO feature at all.
//
// WIRE FORMAT
//   magic(8) 'USRPDOC1' | nonce(12) | tag(16) | ciphertext
// The magic prefix makes sealed/unsealed detectable, which is what keeps this
// change backward-compatible: an object written before the envelope existed is
// returned verbatim. No accepted container can collide with it — PDF starts
// %PDF-, PNG with \x89PNG, JPEG with \xFF\xD8\xFF.
//
// THE AAD IS THE OBJECT PATH, AND THAT IS THE POINT. bucket/key is
// authenticated, so a sealed blob cannot be MOVED and still decrypt. Copying
// applicant A's sealed certificate over applicant B's object key produces a
// hard authentication failure instead of a silently mis-attributed document
// — the kind of tampering an object store's own ACLs cannot detect.
//
// The key is HKDF-derived rather than used raw: the env value is an operator
// passphrase of arbitrary length, not a 32-byte key, and the salt/info pair
// gives domain separation so the same secret can never accidentally produce
// the same key for a different purpose.
// ══════════════════════════════════════════════════════════════════

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('USRPDOC1', 'latin1');
const NONCE_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + NONCE_BYTES + TAG_BYTES;
const KEY_BYTES = 32; // AES-256
const MIN_SECRET_LENGTH = 32; // matches DB_ENCRYPTION_KEY's documented floor

const HKDF_SALT = 'usrp-document-envelope-v1';
const HKDF_INFO = 'minio-object-at-rest';

/**
 * Sealing or opening a document failed. Always LOUD: a document that cannot be
 * authenticated must never be treated as analyzable content.
 */
export class DocumentEnvelopeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DocumentEnvelopeError';
  }
}

/** Derive the 32-byte AES key from the configured operator secret. */
export function deriveEnvelopeKey(secret: string): Buffer {
  if (secret.trim().length < MIN_SECRET_LENGTH) {
    throw new DocumentEnvelopeError(
      `MINIO_ENCRYPTION_KEY must be at least ${MIN_SECRET_LENGTH} characters.`,
    );
  }
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from(HKDF_SALT, 'utf8'),
      Buffer.from(HKDF_INFO, 'utf8'),
      KEY_BYTES,
    ),
  );
}

/**
 * The additional authenticated data for one object: its full store path.
 * Binding it means a ciphertext is only valid AT THE KEY IT WAS WRITTEN TO.
 */
export function envelopeAad(bucket: string, key: string): string {
  return `${HKDF_SALT}|${bucket}/${key}`;
}

/** True when these bytes carry the envelope header. */
export function isSealed(bytes: Buffer): boolean {
  return bytes.length >= HEADER_BYTES && bytes.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Encrypt a document for storage at `aad`'s object path. */
export function sealDocument(key: Buffer, aad: string, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
}

/**
 * Decrypt a stored object.
 *
 * An UNSEALED object is returned verbatim — the store predates this envelope
 * and objects written by the analyze slice's fixtures are plaintext.
 *
 * A SEALED object with NO KEY CONFIGURED THROWS, and that is deliberate. The
 * degraded alternative is returning ciphertext to the analyzer, which would
 * probe it as an unidentifiable container and emit a confident AMBER verdict
 * on bytes it never actually read — a FABRICATED forensic verdict on a
 * citizen's document. Failing loud is the only honest option.
 */
export function openDocument(key: Buffer | undefined, aad: string, stored: Buffer): Buffer {
  if (!isSealed(stored)) return stored;
  if (key === undefined) {
    throw new DocumentEnvelopeError(
      'Object is sealed but no encryption key is configured — refusing to hand ciphertext ' +
        'to the analyzer (it would score unreadable bytes as an unknown container).',
    );
  }
  const nonce = stored.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
  const tag = stored.subarray(MAGIC.length + NONCE_BYTES, HEADER_BYTES);
  const ciphertext = stored.subarray(HEADER_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (cause) {
    throw new DocumentEnvelopeError(
      'Document failed authenticated decryption — wrong key, tampered ciphertext, or an ' +
        'object copied to a different key (the object path is authenticated).',
      { cause },
    );
  }
}
