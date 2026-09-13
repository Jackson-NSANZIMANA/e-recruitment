// ══════════════════════════════════════════════════════════════════
// edge-gateway — The two cookies, and nothing else
//
//   session   opaque handle. httpOnly. No script may read it. This IS the
//             credential, and it is not one the browser can understand.
//   csrf      readable echo. NOT httpOnly, deliberately: on its own it
//             authenticates nothing, and it is useless without the session
//             cookie no script can read.
//
// TWO NAMES PER COOKIE, because `__Host-` cannot be used over plain http —
// browsers SILENTLY DROP such a cookie, and shared-http refuses to serialize
// one rather than let auth fail invisibly. Production is same-origin over TLS
// and uses the prefix; local development over http uses the `_dev` names, which
// is exactly what the frontend's edge-client tries.
// ══════════════════════════════════════════════════════════════════

import type { SetCookie } from '@usrp/shared-http';

export const SESSION_COOKIE_SECURE = '__Host-usrp_session';
export const SESSION_COOKIE_DEV = 'usrp_session_dev';
export const CSRF_COOKIE_SECURE = '__Host-usrp_csrf';
export const CSRF_COOKIE_DEV = 'usrp_csrf_dev';

export interface CookiePolicy {
  readonly secure: boolean;
  readonly sessionCookieName: string;
  readonly csrfCookieName: string;
}

export function cookiePolicy(secure: boolean): CookiePolicy {
  return {
    secure,
    sessionCookieName: secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_DEV,
    csrfCookieName: secure ? CSRF_COOKIE_SECURE : CSRF_COOKIE_DEV,
  };
}

function sessionCookie(policy: CookiePolicy, value: string, clear: boolean): SetCookie {
  return {
    name: policy.sessionCookieName,
    value,
    httpOnly: true,
    secure: policy.secure,
    sameSite: 'Strict',
    path: '/',
    ...(clear ? { maxAgeSeconds: 0 } : {}),
  };
}

function csrfCookie(policy: CookiePolicy, value: string, clear: boolean): SetCookie {
  return {
    name: policy.csrfCookieName,
    value,
    httpOnly: false,
    secure: policy.secure,
    sameSite: 'Strict',
    path: '/',
    ...(clear ? { maxAgeSeconds: 0 } : {}),
  };
}

/**
 * Both cookies for a freshly issued (or rotated) session.
 *
 * NO Max-Age / Expires: these are SESSION cookies, gone when the browser
 * closes. Expiry is authoritative server-side — a lifetime the client controls
 * is not an expiry, and a shared officer console at a district office must not
 * leave a resumable handle behind on the machine.
 */
export function sessionCookies(
  policy: CookiePolicy,
  handle: string,
  csrfToken: string,
): readonly SetCookie[] {
  return [sessionCookie(policy, handle, false), csrfCookie(policy, csrfToken, false)];
}

/** Clear both. Used on logout and on every dead-session 401. */
export function clearedCookies(policy: CookiePolicy): readonly SetCookie[] {
  return [sessionCookie(policy, '', true), csrfCookie(policy, '', true)];
}

/**
 * Drop the session cookie and hand out a FRESH readable CSRF token.
 *
 * This is what makes the anonymous 401 from `GET /edge/v1/session` useful rather
 * than merely correct: the SPA calls that route on mount, and without a CSRF
 * cookie in hand the very first login could not carry the `x-csrf-token` the
 * contract requires it to carry. "CSRF required on login" would be
 * unimplementable by an honest client.
 */
export function anonymousProbeCookies(policy: CookiePolicy, csrfToken: string): readonly SetCookie[] {
  return [sessionCookie(policy, '', true), csrfCookie(policy, csrfToken, false)];
}
