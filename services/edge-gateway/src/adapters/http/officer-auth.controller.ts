// ══════════════════════════════════════════════════════════════════
// edge-gateway — Officer credential exchange
//
// POST /edge/v1/auth/officer/login   { loginHandle, password }  → 204 + cookies
// POST /edge/v1/auth/officer/logout                            → 204
//
// `loginHandle`, NOT `email`. `officer_accounts.login_handle` is a varchar(128)
// and there is no email column anywhere in the credential store; the old
// frontend sent `{ email, password }`, which could never have worked against any
// schema.
//
// THE JWT NEVER REACHES THE BROWSER. It is verified once here — to read the
// agency and roles the session view needs — then sealed into the session row.
// The 204 carries no body at all: the session is read back through
// GET /edge/v1/session so there is exactly ONE shape describing a session rather
// than two that can disagree.
//
// LOGOUT IS THE ONLY REVOCATION AN OFFICER HAS. Per ADR-016 the Ed25519 token is
// non-revocable until expiry, so if the handle outlives the logout there is
// nothing to fall back on. The session row is destroyed server-side; clearing
// the cookie alone is not logout.
// ══════════════════════════════════════════════════════════════════

import type { HttpResult, RouteHandler } from '@usrp/shared-http';
import { verifyAuthToken } from '@usrp/shared-auth';
import { auditEdge } from '../../observability/audit-log.js';
import { UPSTREAM } from '../../registry/upstream-operations.js';
import { clearedCookies, sessionCookies } from '../../security/cookies.js';
import {
  assertWithinLimit,
  clientBucketKey,
  targetBucketKey,
} from '../../security/rate-limiter.js';
import { field } from './projections.js';
import { CREDENTIAL_REJECTED } from './outcomes.js';
import { withAnonymous, withOptionalSession, type EdgeDeps } from './guards.js';
import { readJsonBody, requireBoundedString } from './validation.js';

const MAX_HANDLE = 128; // matches officer_accounts.login_handle varchar(128)
const MAX_PASSWORD = 256;

export function officerLoginHandler(deps: EdgeDeps): RouteHandler {
  return withAnonymous(deps, 'officerLogin', async (ctx): Promise<HttpResult> => {
    const body = await readJsonBody(ctx);
    const loginHandle = requireBoundedString(body.loginHandle, 'loginHandle', MAX_HANDLE);
    const password = requireBoundedString(body.password, 'password', MAX_PASSWORD);

    // Per-target AND per-client. The target bucket is what makes credential
    // stuffing against one account expensive regardless of where it comes from.
    const limits = deps.config.rateLimits;
    const key = deps.config.session.handleHmacKey;
    assertWithinLimit(
      deps.limiter.check(
        targetBucketKey(key, 'officerLogin', loginHandle.toLowerCase()),
        limits.loginPerMinute,
      ),
    );
    assertWithinLimit(
      deps.limiter.check(
        `${clientBucketKey(ctx, limits.trustedProxyHops)}:officerLogin`,
        limits.loginPerMinute,
      ),
    );

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.officerLogin,
      correlationId: ctx.correlationId,
      body: { loginHandle, password },
    });

    // 400 and 401 collapse into one indistinguishable rejection.
    if (upstream.status !== 200) return CREDENTIAL_REJECTED;

    const token = field(upstream.body, 'token');
    const expiresAt = field(upstream.body, 'expiresAt');
    if (typeof token !== 'string' || token.length === 0) {
      return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
    }

    // Verify what we are about to store. A token that does not verify here means
    // the edge and iam-service disagree about the issuer, audience or clock —
    // failing at login names the fault; storing it would surface later as an
    // unexplained 401 from a sibling service.
    const principal = verifyAuthToken(deps.config.auth.authPublicKeyPem, token, {
      now: deps.now(),
      expectedIssuer: deps.config.auth.jwtIssuer,
      expectedAudience: deps.config.auth.jwtAudience,
    });
    if (principal === null || principal.kind !== 'officer') {
      console.error(
        JSON.stringify({
          msg: 'edge_login_token_unverifiable',
          correlationId: ctx.correlationId,
          detail: 'iam-service returned a token this edge cannot verify as an officer principal.',
        }),
      );
      return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
    }

    const issued = await deps.sessions.create(
      {
        kind: 'officer',
        subjectId: principal.subjectId,
        agency: principal.agency,
        roles: principal.roles,
        upstreamCredential: token,
        upstreamExpiresAt: typeof expiresAt === 'string' ? expiresAt : null,
      },
      deps.now(),
    );

    auditEdge({
      action: 'EDGE_SESSION_ISSUED',
      operationId: 'officerLogin',
      correlationId: ctx.correlationId,
      sessionId: issued.session.sessionId,
      subjectId: principal.subjectId,
      agency: principal.agency,
      sessionKind: 'officer',
    });

    return {
      status: 204,
      cookies: sessionCookies(deps.cookies, issued.handle, issued.csrfToken),
    };
  });
}

/**
 * Logout. Declared `anonymous` in the registry because the contract makes it
 * IDEMPOTENT: logging out without a session is also a 204, since a client
 * retrying a logout must never be told it failed. It destroys whatever session
 * the presented handle names, or nothing.
 */
export function officerLogoutHandler(deps: EdgeDeps): RouteHandler {
  return withOptionalSession(deps, 'officerLogout', async (ctx, session) => {
    if (session !== null) {
      await deps.sessions.revoke(session.sessionId, 'officer_logout', deps.now());
      auditEdge({
        action: 'EDGE_SESSION_DESTROYED',
        operationId: 'officerLogout',
        correlationId: ctx.correlationId,
        sessionId: session.sessionId,
        sessionKind: session.kind,
        ...(session.subjectId === null ? {} : { subjectId: session.subjectId }),
        ...(session.agency === null ? {} : { agency: session.agency }),
      });
    }
    return { status: 204, cookies: clearedCookies(deps.cookies) };
  });
}
