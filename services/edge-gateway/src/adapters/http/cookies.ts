// ══════════════════════════════════════════════════════════════════
// edge-gateway — Cookie policy
//
// TWO COOKIES, AND THEY ARE NOT THE SAME KIND OF THING:
//
//   session  httpOnly, Secure, SameSite=Strict, __Host-, Path=/.
//            The only credential the browser holds, and script cannot read it.
//   csrf     readable ON PURPOSE. It authenticates nothing on its own and is
//            useless without the session cookie no script can read; the SPA
//            must be able to echo it into `x-csrf-token`.
//
// TWO NAMES PER COOKIE because `__Host-` cannot be used over plain http —
// browsers SILENTLY DROP such a cookie, and a silently dropped session cookie
// is an unexplainable auth failure. Production uses the prefix; local dev over
// http uses the plain name. shared-http enforces the __Host- invariants at
// serialization time and throws rather than emitting a cookie a browser would
// discard.
// ══════════════════════════════════════════════════════════════════

import { HOST_COOKIE_PREFIX, type SetCookie } from '@usrp/shared-http';

const SESSION_BASE = 'usrp_session';
const CSRF_BASE = 'usrp_csrf';

export interface CookieNames {
  readonly session: string;
  readonly csrf: string;
}

/** Cookie names for the current transport. `secure` MUST be true in production. */
export function cookieNames(secure: boolean): CookieNames {
  return secure
    ? { session: `${HOST_COOKIE_PREFIX}${SESSION_BASE}`, csrf: `${HOST_COOKIE_PREFIX}${CSRF_BASE}` }
    : { session: `${SESSION_BASE}_dev`, csrf: `${CSRF_BASE}_dev` };
}

export interface SessionCookieOptions {
  readonly secure: boolean;
  /** Bound to the session's ABSOLUTE ceiling, never to the sliding window: a
   *  cookie that outlives its session makes every UI state ambiguous. */
  readonly maxAgeSeconds: number;
}

export function sessionCookie(handle: string, options: SessionCookieOptions): SetCookie {
  return {
    name: cookieNames(options.secure).session,
    value: handle,
    httpOnly: true,
    secure: options.secure,
    sameSite: 'Strict',
    path: '/',
    maxAgeSeconds: options.maxAgeSeconds,
  };
}

export function csrfCookie(token: string, options: SessionCookieOptions): SetCookie {
  return {
    name: cookieNames(options.secure).csrf,
    // NOT httpOnly. The SPA reads it to echo the header; that is the entire
    // mechanism. It is not a credential — see the file header.
    value: token,
    httpOnly: false,
    secure: options.secure,
    sameSite: 'Strict',
    path: '/',
    maxAgeSeconds: options.maxAgeSeconds,
  };
}

/**
 * Clear both cookies. Emitted on every logout AND whenever an upstream rejects
 * the credential the edge was holding — leaving a cookie pointing at a session
 * that no longer exists turns one clean 401 into a loop of them.
 */
export function clearedCookies(secure: boolean): readonly SetCookie[] {
  const names = cookieNames(secure);
  return [
    {
      name: names.session,
      value: '',
      httpOnly: true,
      secure,
      sameSite: 'Strict',
      path: '/',
      maxAgeSeconds: 0,
    },
    {
      name: names.csrf,
      value: '',
      httpOnly: false,
      secure,
      sameSite: 'Strict',
      path: '/',
      maxAgeSeconds: 0,
    },
  ];
}
