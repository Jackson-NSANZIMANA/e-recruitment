// ══════════════════════════════════════════════════════════════════
// edge-gateway — Token primitives (neutral, transport-free)
//
// WHY THIS FILE EXISTS. The CSRF token is minted by the SESSION STORE (it is
// persisted as a keyed hash on the session row) and checked by the HTTP CSRF
// guard. When the primitives lived in adapters/http/csrf.ts the persistence
// adapter imported an HTTP adapter, which is the dependency arrow pointing the
// wrong way. Both adapters now depend on this module and on nothing else here.
//
// Nothing in this file knows about requests, cookies or SQL.
// ══════════════════════════════════════════════════════════════════

import { randomBytes } from 'node:crypto';
import { hmacSha256Hex } from '@usrp/shared-security';

/** 32 bytes of hex: always valid cookie-octets, so shared-http never refuses it. */
export function newCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

/** The keyed hash stored on the session row. Domain-separated from the handle hash. */
export function csrfTokenHash(hmacKey: string, token: string): string {
  return hmacSha256Hex(hmacKey, `csrf:${token}`);
}

/** A fresh opaque session handle. base64url is always valid cookie-octets. */
export function newSessionHandle(): string {
  return randomBytes(32).toString('base64url');
}

/** The keyed hash of a session handle. The cleartext handle never reaches a query. */
export function sessionHandleHash(hmacKey: string, handle: string): string {
  return hmacSha256Hex(hmacKey, `handle:${handle}`);
}
