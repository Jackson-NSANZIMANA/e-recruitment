// ══════════════════════════════════════════════════════════════════
// edge-gateway — At-rest protection for the stored upstream credential
//
// The session row holds a LIVE credential: an officer's Ed25519 JWT, which
// ADR-016 makes NON-REVOCABLE until it expires, or a citizen's opaque session
// token. A database dump of plaintext credentials is therefore a dump of
// working logins that no revocation can take back — which is precisely the
// threat EDGE_SESSION_HMAC_KEY already addresses for the handle itself.
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
// ══════════════════════════════════════════════════════════════════

import { createHmac } from 'node:crypto';
import { aesGcmDecrypt, aesGcmEncrypt } from '@usrp/shared-security';

/** Versioned so a future rotation can be told apart from the current scheme. */
const CREDENTIAL_KEY_LABEL = 'usrp.edge.credential.aes256gcm.v1';

/** A 32-byte key, so aesGcmEncrypt uses it directly rather than re-hashing. */
export function deriveCredentialKey(rootHmacKey: string): Buffer {
  return createHmac('sha256', rootHmacKey).update(CREDENTIAL_KEY_LABEL).digest();
}

export interface CredentialCipher {
  seal(plaintext: string): string;
  /** Throws DecryptionError on a tampered or truncated envelope — never returns garbage. */
  open(envelope: string): string;
}

export function createCredentialCipher(rootHmacKey: string): CredentialCipher {
  const key = deriveCredentialKey(rootHmacKey);
  return {
    seal: (plaintext: string): string => aesGcmEncrypt(key, plaintext),
    open: (envelope: string): string => aesGcmDecrypt(key, envelope),
  };
}
