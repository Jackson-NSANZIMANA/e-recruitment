// ══════════════════════════════════════════════════════════════════
// edge-gateway — Handles, CSRF tokens, and how they are stored
//
// A handle is 32 bytes of CSPRNG, base64url-encoded. base64url matters: it is
// always a valid RFC 6265 cookie-octet, so shared-http's cookie serializer —
// which REFUSES rather than escapes an invalid value — can never be handed
// something it must reject at response time.
//
// What lands in the table is HMAC-SHA256(handle) under a key that lives in the
// process (HSM/KMS in production). A bare SHA-256 would be enough to stop a
// dump being *directly* replayable and not enough to stop it being replayable
// at all — the input is a known-length token from a known alphabet.
// ══════════════════════════════════════════════════════════════════

import { randomBytes } from 'node:crypto';
import { hmacSha256Hex } from '@usrp/shared-security';

const HANDLE_BYTES = 32;
const CSRF_BYTES = 32;

export function mintHandle(): string {
  return randomBytes(HANDLE_BYTES).toString('base64url');
}

/** The readable CSRF echo value. Not a credential; see adapters/http/csrf.ts. */
export function mintCsrfToken(): string {
  return randomBytes(CSRF_BYTES).toString('base64url');
}

/** The only value that is ever written to or read from the store as a key. */
export function hashHandle(handle: string, hmacKey: string): string {
  return hmacSha256Hex(hmacKey, handle);
}
