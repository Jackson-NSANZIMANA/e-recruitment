// ══════════════════════════════════════════════════════════════════
// edge-gateway — Session introspection and refresh
//
// GET  /edge/v1/session          the SPA's mount-time probe
// POST /edge/v1/session/refresh  advance the idle window, rotate the secrets
//
// The 200 body is session METADATA and no credential. There is no field for a
// token, so no component can read, log, or forward one.
//
// REFRESH ROTATES BOTH SECRETS. A refresh that only extends a deadline leaves a
// stolen handle valid for the whole absolute window; rotating means a thief's
// copy dies the next time the real client refreshes. The absolute ceiling is
// never advanced, so the UI can tell the truth about when the session ends.
// ══════════════════════════════════════════════════════════════════

import type { HttpResult, RouteHandler } from '@usrp/shared-http';
import { toSessionView } from '../../domain/session.types.js';
import { clearedCookies, sessionCookies } from './cookies.js';
import { anonymousProbeResult, withOptionalSession, type EdgeDeps } from './guards.js';

export function readSessionHandler(deps: EdgeDeps): RouteHandler {
  return withOptionalSession(deps, 'readSession', (_ctx, session, endedReason) => {
    if (session === null) {
      return Promise.resolve(anonymousProbeResult(deps, endedReason ?? 'revoked'));
    }
    return Promise.resolve({ status: 200, body: toSessionView(session) });
  });
}

export function refreshSessionHandler(deps: EdgeDeps): RouteHandler {
  return withOptionalSession(deps, 'refreshSession', async (ctx, session, endedReason) => {
    if (session === null) {
      // Not the probe result: refresh is an explicit action, so the caller gets
      // the plain 401 rather than a fresh CSRF seed.
      deps.audit.log({
        action: 'EDGE_SESSION_REJECTED',
        operationId: 'refreshSession',
        correlationId: ctx.correlationId,
        reason: endedReason ?? 'revoked',
      });
      return { status: 401, body: { reason: endedReason ?? 'revoked' } };
    }

    const rotated = await deps.sessions.rotate(session.sessionId, deps.now());
    if (rotated === null) {
      // Revoked between resolve and rotate (a logout in another tab). Say so,
      // and clear the jar, instead of handing out a handle that was never stored.
      deps.audit.log({
        action: 'EDGE_SESSION_REJECTED',
        operationId: 'refreshSession',
        correlationId: ctx.correlationId,
        sessionId: session.sessionId,
        reason: 'revoked',
      });
      return { status: 401, body: { reason: 'revoked' }, cookies: clearedCookies(deps.cookies) };
    }

    deps.audit.log({
      action: 'EDGE_SESSION_REFRESHED',
      operationId: 'refreshSession',
      correlationId: ctx.correlationId,
      sessionId: session.sessionId,
      sessionKind: session.kind,
      ...(session.agency === null ? {} : { agency: session.agency }),
    });

    // Describe the session AS ROTATED. The pre-rotate object still carries the
    // old idle deadline; returning it would tell the SPA its session ends earlier
    // than the database (and the new cookie) say it does.
    const refreshed = {
      ...session,
      idleExpiresAt: rotated.idleExpiresAt,
      absoluteExpiresAt: rotated.absoluteExpiresAt,
    };
    const result: HttpResult = {
      status: 200,
      body: toSessionView(refreshed),
      cookies: sessionCookies(deps.cookies, rotated.handle, rotated.csrfToken),
    };
    return result;
  });
}
