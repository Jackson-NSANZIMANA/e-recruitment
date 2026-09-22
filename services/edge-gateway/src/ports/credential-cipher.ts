// ══════════════════════════════════════════════════════════════════
// edge-gateway — Credential cipher port
//
// The abstract interface for cryptographic operations: hashing session handles,
// generating and verifying CSRF tokens, and deriving credential encryption keys.
//
// The application layer uses this to secure session handles and CSRF tokens
// without coupling to Node.js crypto, the HMAC algorithm, or any concrete
// implementation.
//
// Implementations: adapters/credential-cipher.adapter.ts
// ══════════════════════════════════════════════════════════════════

/**
 * Credential cipher port. Wraps the cryptographic primitives the edge needs:
 * - Session handle hashing (so cleartext handles never hit the database)
 * - CSRF token generation and validation
 * - Credential encryption key derivation
 *
 * All operations use the HMAC secret from config (EDGE_SESSION_HMAC_KEY).
 */
export interface CredentialCipher {
  /**
   * Hash a cleartext session handle for database lookup. The handle is
   * cryptographically random (32 bytes), so this is not password hashing —
   * it is a keyed hash to ensure a stolen database does not immediately
   * yield working session cookies.
   *
   * @param handle Cleartext session handle (from cookie)
   * @returns Handle hash (stored in edge_sessions.handle_hash)
   */
  hashHandle(handle: string): string;

  /**
   * Generate a CSRF token for a session. The token is deterministic (derived
   * from the session id and HMAC key), so the same session always produces
   * the same token. This lets the edge validate CSRF tokens without storing
   * them in the database.
   *
   * @param sessionId The session's database id
   * @returns CSRF token (sent to browser, validated on unsafe requests)
   */
  generateCsrfToken(sessionId: string): string;

  /**
   * Hash a CSRF token for storage. The edge stores the hash, not the cleartext
   * token, so a stolen database does not immediately yield working CSRF tokens.
   *
   * @param token Cleartext CSRF token
   * @returns CSRF token hash (stored in edge_sessions.csrf_token_hash)
   */
  hashCsrfToken(token: string): string;

  /**
   * Derive a symmetric encryption key for upstream credentials. The key is
   * derived from the HMAC secret and a context string, so different contexts
   * (credential encryption vs. handle hashing) produce different keys from
   * the same secret.
   *
   * @param context Key derivation context (e.g., 'edge-credential')
   * @returns 32-byte encryption key
   */
  deriveKey(context: string): Buffer;
}
