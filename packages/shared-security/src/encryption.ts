// ══════════════════════════════════════════════════════════════════
// @usrp/shared-security — AES-256-GCM authenticated encryption
//
// Application-level encryption for secrets that live outside the database
// (the PII columns themselves are encrypted at the DB layer via pgcrypto).
// GCM provides confidentiality AND integrity: any tampering fails the auth
// tag on decrypt. Envelope format: base64(iv).base64(tag).base64(ciphertext)
// ══════════════════════════════════════════════════════════════════

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const IV_BYTES = 12; // 96-bit nonce — GCM standard
const KEY_BYTES = 32; // AES-256

export class DecryptionError extends Error {
  constructor(message = 'Decryption failed — ciphertext missing, malformed, or tampered') {
    super(message);
    this.name = 'DecryptionError';
  }
}

/**
 * Coerce a key string/buffer to exactly 32 bytes. A key already 32 bytes
 * is used as-is; anything else is run through SHA-256 to derive a stable
 * 256-bit key (config enforces a >=32-char floor upstream).
 */
function normalizeKey(key: string | Buffer): Buffer {
  const buf = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  if (buf.length === KEY_BYTES) return buf;
  return createHash('sha256').update(buf).digest();
}

export function aesGcmEncrypt(key: string | Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', normalizeKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function aesGcmDecrypt(key: string | Buffer, envelope: string): string {
  const parts = envelope.split('.');
  if (parts.length !== 3) throw new DecryptionError('Malformed ciphertext envelope');
  const [ivB64, tagB64, ctB64] = parts;
  if (ivB64 === undefined || tagB64 === undefined || ctB64 === undefined) {
    throw new DecryptionError('Malformed ciphertext envelope');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', normalizeKey(key), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new DecryptionError();
  }
}
