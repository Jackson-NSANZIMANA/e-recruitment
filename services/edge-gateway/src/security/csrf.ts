// ══════════════════════════════════════════════════════════════════
// edge-gateway — CSRF: double submit, bound to the session, failing loudly
//
// SameSite=Strict is necessary and not sufficient. Two checks run on every
// unsafe request:
//
//   1. DOUBLE SUBMIT — the `x-csrf-token` header must equal the readable echo
//      cookie. A cross-site page can cause a request but cannot read the
//      cookie to populate the header.
//   2. SESSION BINDING — for an authenticated caller the token must also match
//      the keyed hash stored on the session row. Double submit alone accepts
//      any self-consistent pair, so an attacker who can write a cookie on a
//      sibling host (which `__Host-` prevents, but which the dev name does not)
//      could otherwise supply BOTH halves. The stored hash is the half no
//      client can forge.
//
// A previous hash is honoured inside a bounded grace window. Refresh rotates
// the token, and an SPA has requests in flight while it does; without the
// window, rotation would 403 the app's own concurrent writes and look exactly
// like a CSRF bug.
//
// Missing or mismatched is a 403, always. A forgotten token must break visibly
// in development rather than silently weaken CSRF in production.
// ══════════════════════════════════════════════════════════════════

import { randomBytes } from 'node:crypto';
import { HttpError, type RequestContext } from '@usrp/shared-http';
import { hmacSha256Hex, timingSafeEqualHex } from '@usrp/shared-security';

export const CSRF_HEADER = 'x-csrf-token';

/** 32 bytes of hex — always valid cookie-octets, so shared-http never refuses it. */
export function newCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

export function csrfTokenHash(hmacKey: string, token: string): string {
  return hmacSha256Hex(hmacKey, `csrf:${token}`);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** What the session row knows about acceptable tokens. Null for anonymous callers. */
export interface CsrfBinding {
  readonly currentHash: string;
  /** Set only during the post-rotation grace window. */
  readonly previousHash: string | null;
}

function reject(): never {
  // Deliberately one code and no detail. "Which half failed" is information an
  // attacker can use to probe, and a legitimate client never needs it.
  throw new HttpError(403, 'CSRF_REJECTED', 'Missing or invalid CSRF token.');
}

export function assertCsrf(
  ctx: RequestContext,
  csrfCookieName: string,
  hmacKey: string,
  binding: CsrfBinding | null,
): void {
  const header = firstHeader(ctx.headers[CSRF_HEADER])?.trim();
  const cookie = ctx.cookies.get(csrfCookieName);

  if (header === undefined || header.length === 0 || cookie === undefined || cookie.length === 0) {
    reject();
  }
  // timingSafeEqualHex returns false on any length mismatch and on non-hex
  // input (the decoded buffers differ in length), so a garbage header cannot
  // short-circuit into a true.
  if (!timingSafeEqualHex(header, cookie)) {
    reject();
  }
  if (binding === null) {
    // Anonymous caller: there is no server-side half to bind to yet, which is
    // the whole reason login is also rate-limited and origin-checked by CORS.
    return;
  }
  const presented = csrfTokenHash(hmacKey, header);
  if (timingSafeEqualHex(presented, binding.currentHash)) {
    return;
  }
  if (binding.previousHash !== null && timingSafeEqualHex(presented, binding.previousHash)) {
    return;
  }
  reject();
}
