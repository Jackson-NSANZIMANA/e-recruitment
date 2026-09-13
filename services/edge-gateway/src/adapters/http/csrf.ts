// ══════════════════════════════════════════════════════════════════
// edge-gateway — CSRF: double-submit, bound to the session, failing loudly
//
// SameSite=Strict is necessary and NOT sufficient, so every unsafe request must
// echo the readable cookie in `x-csrf-token`.
//
// TWO COMPARISONS, NOT ONE, and the difference matters:
//
//   • With a session, the header is compared against the token STORED WITH THE
//     SESSION. Plain double-submit (cookie == header) is defeated by cookie
//     injection: anything that can write a cookie for this host can write both
//     halves. `__Host-` closes most of that door; comparing against a value the
//     attacker never saw closes it completely.
//   • Without a session (login, OTP), there is nothing stored yet, so it falls
//     back to cookie == header. That is the classic construction and it is
//     sound here because the session cookie does not exist to be stolen yet.
//
// A missing or mismatched header is a 403, always. It is a client bug — the
// browser attaches the cookie automatically — and a forgotten token must break
// visibly in development rather than silently weaken CSRF in production.
// ══════════════════════════════════════════════════════════════════

import { timingSafeEqual } from 'node:crypto';
import type { RequestContext } from '@usrp/shared-http';
import { cookieNames } from './cookies.js';

export const CSRF_HEADER = 'x-csrf-token';

/** Methods that change state and therefore require the header. */
const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isUnsafe(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

/**
 * Constant-time string comparison. Length is compared first and leaks: both
 * values are fixed-length 32-byte base64url tokens, so length carries no
 * information an attacker does not already have.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function headerToken(ctx: RequestContext): string | null {
  const raw = ctx.headers[CSRF_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Verify the double-submit for an unsafe request.
 *
 * @param expected the token stored with the session, or null when there is no
 *                 session yet (then the readable cookie is the reference).
 */
export function csrfAccepted(
  ctx: RequestContext,
  secure: boolean,
  expected: string | null,
): boolean {
  if (!isUnsafe(ctx.method)) return true;
  const header = headerToken(ctx);
  if (header === null) return false;
  if (expected !== null) return constantTimeEquals(header, expected);
  const cookie = ctx.cookies.get(cookieNames(secure).csrf);
  if (cookie === undefined) return false;
  return constantTimeEquals(header, cookie);
}
