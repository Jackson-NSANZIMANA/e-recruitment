// ══════════════════════════════════════════════════════════════════
// edge-gateway — Session introspection + refresh
//
// `GET /edge/v1/session` is the SPA's first call on every mount, and its 401 is
// a NORMAL, EXPECTED outcome: the app must be able to distinguish `checking`
// from `anonymous`, or it flashes a login screen at an authenticated user.
//
// It also SEEDS THE CSRF COOKIE. That is not incidental — it is what makes the
// double-submit work for the very first unsafe request (a login), which by
// definition happens before any session exists. Without it the SPA's first POST
// would have no token to echo and would 403 by design.
//
// Neither response carries a credential. There is no field for one: the type
// returned by `projectSession` has no `token` property, so no component
// downstream can read, log or forward one.
// ══════════════════════════════════════════════════════════════════

import type { HttpResult, RequestContext, Route, SetCookie } from '@usrp/shared-http';
import { projectSession } from '../../domain/session.js';
import { mintCsrfToken } from '../../domain/handle.js';
import { clearedCookies, csrfCookie, sessionCookie } from './cookies.js';
import { csrfAccepted } from './csrf.js';
import type { EdgeDeps } from './deps.js';
import { faultToResult, readHandle } from './guard.js';
import { EDGE_PATHS } from './paths.js';
import { csrfRejected, sessionEnded } from './responses.js';

export function sessionRoutes(deps: EdgeDeps): Route[] {
  return [
    {
      method: 'GET',
      path: EDGE_PATHS.session,
      handler: async (ctx: RequestContext): Promise<HttpResult> => {
        const secure = deps.secureCookies;
        const handle = readHandle(ctx, secure);
        if (handle === undefined) {
          // Anonymous. Hand out a CSRF token so the login POST has one to echo.
          return {
            ...sessionEnded(),
            cookies: [
              csrfCookie(mintCsrfToken(), { secure, maxAgeSeconds: deps.preSessionTtlSeconds }),
            ],
          };
        }
        try {
          // PEEK, not touch: reading "am I still signed in?" must not itself
          // extend the session. Advancing the idle window is what
          // /session/refresh is for, and keeping them separate is why the SPA
          // can poll session state without making an idle timeout unreachable.
          const lookup = await deps.sessions.peek(handle);
          if (lookup.kind === 'NONE' || lookup.kind === 'ENDED') {
            const reason = lookup.kind === 'ENDED' ? lookup.reason : 'revoked';
            return {
              ...sessionEnded(reason),
              cookies: [
                ...clearedCookies(secure),
                csrfCookie(mintCsrfToken(), { secure, maxAgeSeconds: deps.preSessionTtlSeconds }),
              ],
            };
          }
          const session = lookup.session;
          const maxAgeSeconds = Math.max(
            1,
            Math.floor((session.absoluteExpiresAt.getTime() - Date.now()) / 1000),
          );
          // Re-emit the session's own CSRF token: a browser that lost the
          // readable cookie (cleared by the user, expired) would otherwise be
          // permanently unable to write, with a live session and no way to use it.
          return {
            status: 200,
            body: projectSession(session),
            cookies: [csrfCookie(session.csrfToken, { secure, maxAgeSeconds })],
          };
        } catch (err) {
          const mapped = faultToResult(err, secure);
          if (mapped !== null) return mapped;
          throw err;
        }
      },
    },
    {
      method: 'POST',
      path: EDGE_PATHS.sessionRefresh,
      handler: async (ctx: RequestContext): Promise<HttpResult> => {
        const secure = deps.secureCookies;
        const handle = readHandle(ctx, secure);
        if (handle === undefined) return sessionEnded();
        try {
          // Resolve first so CSRF can be checked against the STORED token
          // rather than against a cookie an injector could also have written.
          const lookup = await deps.sessions.peek(handle);
          if (lookup.kind === 'NONE' || lookup.kind === 'ENDED') {
            const reason = lookup.kind === 'ENDED' ? lookup.reason : 'revoked';
            return { ...sessionEnded(reason), cookies: clearedCookies(secure) };
          }
          if (!csrfAccepted(ctx, secure, lookup.session.csrfToken)) return csrfRejected();

          const slid = await deps.sessions.touch(handle);
          if (slid.kind !== 'LIVE') {
            // It expired between the two statements. Honest, and rare.
            const reason = slid.kind === 'ENDED' ? slid.reason : 'revoked';
            return { ...sessionEnded(reason), cookies: clearedCookies(secure) };
          }
          // Note what is NOT re-emitted: the session cookie. Its Max-Age is
          // bound to the ABSOLUTE ceiling, which a refresh never moves, so
          // re-issuing it would silently extend the hard limit the UI is
          // promising the user.
          return { status: 200, body: projectSession(slid.session) };
        } catch (err) {
          const mapped = faultToResult(err, secure);
          if (mapped !== null) return mapped;
          throw err;
        }
      },
    },
  ];
}

/** The two cookies a successful authentication emits. */
export function issuedCookies(
  handle: string,
  csrfToken: string,
  secure: boolean,
  maxAgeSeconds: number,
): readonly SetCookie[] {
  return [
    sessionCookie(handle, { secure, maxAgeSeconds }),
    csrfCookie(csrfToken, { secure, maxAgeSeconds }),
  ];
}
