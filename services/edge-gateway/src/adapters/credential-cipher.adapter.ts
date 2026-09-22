// ══════════════════════════════════════════════════════════════════
// edge-gateway — Credential cipher adapter (complete implementation)
//
// Implements the CredentialCipher port using Node.js crypto primitives and
// @usrp/shared-security utilities. Wraps HMAC-SHA256 operations for session
// handle hashing, CSRF token generation, and AES-256-GCM encryption/decryption
// for upstream credentials.
//
// The upstream credential (officer JWT or applicant session handle) is stored
// encrypted in edge_sessions. A database dump does not immediately yield
// working credentials.
//
// THE KEY IS DERIVED, NOT CONFIGURED. HMAC-SHA256(EDGE_SESSION_HMAC_KEY,
// domain-label) gives a distinct 256-bit key for this purpose from a root
// secret that already exists, is already 32+ chars by validator, and — the
// deciding reason — is already FINGERPRINTED by assertProductionSecrets(). A
// brand-new EDGE_CREDENTIAL_ENCRYPTION_KEY in .env.example would be a
// published dev key the production guard has never heard of, so a process
// could boot in production sealing officer JWTs under a key that is in git.
//
// Domain separation is not decoration: the same root secret keys the stored
// handle hash, and reusing one key for a MAC and a cipher is how key-reuse
// bugs are built.
//
// Part of hexagonal architecture refactoring - adapter layer.
// ══════════════════════════════════════════════════════════════════

import { createHmac, createHash } from 'node:crypto';
import { aesGcmDecrypt, aesGcmEncrypt } from '@usrp/shared-security';
import type { CredentialCipher } from '../ports/credential-cipher.js';

/** Versioned so a future rotation can be told apart from the current scheme. */
const CREDENTIAL_KEY_LABEL = 'usrp.edge.credential.aes256gcm.v1';

/**
 * Complete credential cipher adapter implementing encryption and hashing.
 *
 * This adapter extends the basic CredentialCipher port with the seal/open
 * methods needed by PgEdgeSessionStore for credential encryption.
 */
export interface FullCredentialCipher extends CredentialCipher {
  /**
   * Encrypt an upstream credential (AES-256-GCM). Returns base64 encoding from
   * shared-security aesGcmEncrypt.
   */
  seal(plaintext: string): string;

  /**
   * Decrypt an upstream credential. Throws DecryptionError if decryption fails
   * (wrong key or tampering detected by GCM) — never returns garbage.
   */
  open(envelope: string): string;
}

/**
 * Node.js crypto implementation of CredentialCipher with full encryption support.
 * Uses @usrp/shared-security for AES-256-GCM operations.
 */
export class NodeCredentialCipher implements FullCredentialCipher {
  readonly #hmacKey: string;
  readonly #encryptionKey: Buffer;

  constructor(hmacKey: string) {
    this.#hmacKey = hmacKey;
    // Derive encryption key from HMAC key with domain separation
    this.#encryptionKey = this.deriveKey(CREDENTIAL_KEY_LABEL);
  }

  hashHandle(handle: string): string {
    return createHmac('sha256', this.#hmacKey)
      .update(`handle:${handle}`)
      .digest('hex');
  }

  generateCsrfToken(sessionId: string): string {
    return createHmac('sha256', this.#hmacKey)
      .update(`csrf:${sessionId}`)
      .digest('base64url');
  }

  hashCsrfToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  deriveKey(context: string): Buffer {
    return createHmac('sha256', this.#hmacKey)
      .update(context)
      .digest();
  }

  seal(plaintext: string): string {
    return aesGcmEncrypt(this.#encryptionKey, plaintext);
  }

  open(envelope: string): string {
    return aesGcmDecrypt(this.#encryptionKey, envelope);
  }
}

/**
 * Factory function for creating credential cipher (maintains existing API).
 */
export function createCredentialCipher(hmacKey: string): FullCredentialCipher {
  return new NodeCredentialCipher(hmacKey);
}

/**
 * Derive credential encryption key (existing export for backward compatibility).
 * A 32-byte key, so aesGcmEncrypt uses it directly rather than re-hashing.
 */
export function deriveCredentialKey(rootHmacKey: string): Buffer {
  return createHmac('sha256', rootHmacKey).update(CREDENTIAL_KEY_LABEL).digest();
}
