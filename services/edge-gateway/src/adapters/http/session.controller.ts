// ══════════════════════════════════════════════════════════════════
// edge-gateway — Session introspection and refresh
//
// GET  /edge/v1/session          the SPA's mount-time probe
// POST /edge/v1/session/refresh  advance the idle window, rotate the secrets
//
// The 200 body is session METADATA and no credential. There is no field for a
// token, so no component can read, log, or forward one. This replaces the
// fictional `GET /auth/me`, which no service ever served and which returned a
// decoded JWT payload including an email and a `SUPERADMIN` role — a role that
// is unrepresentable end to end, because RLS is FORCE'd with NOLOGIN group roles
// and there is no bypass principal.
//
// REFRESH ROTATES BOTH SECRETS. A refresh that only extends a deadline leaves a
// stolen handle valid for the whole absolute window; rotating means a thief's
// copy dies the next time the real client refreshes. The absolute ceiling is
// never advanced, so the UI can tell the truth about when the session ends
// however active the user is.
// ══════════════════════════════════════════════════════════════════

import type { HttpResult, RouteHandler } from '@usrp/shared-http';
import { auditEdge } from '../../observability/audit-log.js';
import { sessionCookies } from '../../security/cookies.js';
import { toSessionView } from '../../session/session.types.js';
import { anonymousProbeResult, withOptionalSession, type EdgeDeps } from './guards.js';

export function readSessionHandler(deps: EdgeDeps): RouteHandler {
  return withOptionalSession(deps, 'readSession', async (_ctx, session, endedReason) => {
    if (session === null) {
      return anonymousProbeResult(deps, endedReason ?? 'revoked');
    }
    return { status: 200, body: toSessionView(session) };
  });
}

export function refreshSessionHandler(deps: EdgeDeps): RouteHandler {
  return withOptionalSession(deps, 'refreshSession', async (ctx, session, endedReason) => {
    if (session === null) {
      // Not the probe result: refresh is an explicit action, so the caller gets
      // the plain 401 with cleared cookies rather than a fresh CSRF seed.
      auditEdge({
        action: 'EDGE_SESSION_REJECTED',
        operationId: 'refreshSession',
        correlationId: ctx.correlationId,
        reason: endedReason ?? 'revoked',
      });
      return { status: 401, body: { reason: endedReason ?? 'revoked' } };
    }

    const issued = await deps.sessions.rotate(session, deps.now());
    auditEdge({
      action: 'EDGE_SESSION_REFRESHED',
      operationId: 'refreshSession',
      correlationId: ctx.correlationId,
      sessionId: issued.session.sessionId,
      sessionKind: issued.session.kind,
      ...(issued.session.agency === null ? {} : { agency: issued.session.agency }),
    });

    const result: HttpResult = {
      status: 200,
      body: toSessionView(issued.session),
      cookies: sessionCookies(deps.cookies, issued.handle, issued.csrfToken),
    };
    return result;
  });
}
