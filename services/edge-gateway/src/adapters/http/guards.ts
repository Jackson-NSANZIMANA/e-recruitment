// ══════════════════════════════════════════════════════════════════
// edge-gateway — The enforcement seam
//
// shared-http is deliberately a byte-moving substrate with no middleware
// concept (ADR-005), so authorization is a higher-order function applied at
// route assembly — the same shape as shared-auth's withAuth, but resolving an
// opaque edge handle instead of verifying a bearer token.
//
// ORDER MATTERS AND IS DELIBERATE:
//
//   1. Session first on authenticated operations. An officer whose session
//      expired mid-form must be told "your session ended", not "your CSRF token
//      is wrong" — and the CSRF binding lives on the session row anyway.
//   2. CSRF first on anonymous operations. There is no session to consult, and
//      login is exactly the request a cross-site page would like to forge.
//   3. Wrong session KIND is 403, never 401. The caller is authenticated; the
//      credential is simply not interchangeable (ADR-016 vs ADR-018). A 401
//      would send the SPA into a login loop it can never win.
//
// A dead or unknown handle always ships CLEARED COOKIES with the 401. Leaving a
// stale handle in the jar means every subsequent request pays a database lookup
// to be told the same thing.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type RequestContext, type RouteHandler } from '@usrp/shared-http';
import type { Agency } from '@usrp/shared-types';
import { auditEdge } from '../../observability/audit-log.js';
import { edgeOperation, type EdgeOperationId } from '../../registry/edge-operations.js';
import { clearedCookies, csrfCookieOnly, type CookiePolicy } from '../../security/cookies.js';
import { assertCsrf, newCsrfToken, type CsrfBinding } from '../../security/csrf.js';
import { FixedWindowRateLimiter } from '../../security/rate-limiter.js';
import type { PgEdgeSessionStore } from '../../session/session-store.pg.js';
import type { EdgeSession } from '../../session/session.types.js';
import { UpstreamUnavailableError, type UpstreamClient } from '../../upstream/upstream-client.js';
import type { EdgeGatewayConfig } from '../../config.js';
import { ForbiddenFieldError } from './validation.js';

export interface EdgeDeps {
  readonly config: EdgeGatewayConfig;
  readonly cookies: CookiePolicy;
  readonly sessions: PgEdgeSessionStore;
  readonly upstream: UpstreamClient;
  readonly limiter: FixedWindowRateLimiter;
  readonly now: () => Date;
}

/** An officer handler receives the session AND its agency, already narrowed. */
export type OfficerHandler = (
  ctx: RequestContext,
  session: EdgeSession,
  agency: Agency,
) => Promise<HttpResult>;

export type ApplicantHandler = (ctx: RequestContext, session: EdgeSession) => Promise<HttpResult>;

export type AnonymousHandler = (ctx: RequestContext) => Promise<HttpResult>;

function bindingFor(session: EdgeSession): CsrfBinding {
  return { currentHash: session.csrfTokenHash, previousHash: session.previousCsrfTokenHash };
}

/** The contract's 401: a `reason` the UI can turn into a true sentence. */
function sessionEnded(deps: EdgeDeps, reason: string): HttpResult {
  return {
    status: 401,
    body: { reason },
    cookies: clearedCookies(deps.cookies),
  };
}

/**
 * Translate anything a handler throws into a browser-safe result.
 *
 * UpstreamUnavailableError becomes the contract's G2GError — body `{ error }`
 * and nothing else, because "the national ID registry is unavailable" is
 * actionable while an upstream stack detail is a leak.
 */
async function guarded(
  operationId: EdgeOperationId,
  ctx: RequestContext,
  run: () => Promise<HttpResult>,
): Promise<HttpResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof UpstreamUnavailableError) {
      auditEdge({
        action: 'EDGE_UPSTREAM_UNAVAILABLE',
        operationId,
        correlationId: ctx.correlationId,
        reason: err.code,
        detail: { upstream: err.upstreamOperationId },
      });
      return { status: 503, body: { error: err.code } };
    }
    if (err instanceof ForbiddenFieldError) {
      auditEdge({
        action: 'EDGE_FORBIDDEN_FIELD_REJECTED',
        operationId,
        correlationId: ctx.correlationId,
        detail: { field: err.field },
      });
      throw err;
    }
    if (err instanceof HttpError) {
      if (err.code === 'CSRF_REJECTED') {
        auditEdge({ action: 'EDGE_CSRF_REJECTED', operationId, correlationId: ctx.correlationId });
      }
      if (err.code === 'RATE_LIMITED') {
        auditEdge({ action: 'EDGE_RATE_LIMITED', operationId, correlationId: ctx.correlationId });
      }
      throw err;
    }
    throw err;
  }
}

/**
 * Anonymous operations. CSRF is still enforced when the registry says so, using
 * pure double-submit — there is no session half to bind to yet, which is why
 * these four operations are also the rate-limited ones.
 */
export function withAnonymous(
  deps: EdgeDeps,
  operationId: EdgeOperationId,
  handler: AnonymousHandler,
): RouteHandler {
  const operation = edgeOperation(operationId);
  return async (ctx: RequestContext): Promise<HttpResult> =>
    guarded(operationId, ctx, async () => {
      if (operation.csrf) {
        assertCsrf(ctx, deps.cookies.csrfCookieName, deps.config.session.handleHmacKey, null);
      }
      return handler(ctx);
    });
}

async function resolveSession(
  deps: EdgeDeps,
  ctx: RequestContext,
): Promise<
  | { readonly kind: 'ACTIVE'; readonly session: EdgeSession }
  | { readonly kind: 'ENDED'; readonly reason: string }
> {
  const handle = ctx.cookies.get(deps.cookies.sessionCookieName);
  if (handle === undefined || handle.length === 0) {
    // No cookie at all is `revoked` to the caller: an absent handle and a
    // destroyed one are the same fact from the browser's side, and inventing a
    // fourth reason for "you never had one" tells the UI nothing it can use.
    return { kind: 'ENDED', reason: 'revoked' };
  }
  const lookup = await deps.sessions.resolve(handle, deps.now());
  if (lookup.kind === 'ACTIVE') return { kind: 'ACTIVE', session: lookup.session };
  // UNKNOWN and revoked are reported identically — a handle-existence oracle
  // would let an attacker confirm a stolen handle was once real.
  return { kind: 'ENDED', reason: lookup.kind === 'UNKNOWN' ? 'revoked' : lookup.reason };
}

function wrongKind(
  deps: EdgeDeps,
  operationId: EdgeOperationId,
  ctx: RequestContext,
  actual: string,
  required: string,
): HttpResult {
  auditEdge({
    action: 'EDGE_WRONG_SESSION_KIND',
    operationId,
    correlationId: ctx.correlationId,
    sessionKind: actual,
    reason: required,
  });
  void deps;
  return { status: 403, body: { error: 'WRONG_SESSION_KIND' } };
}

export function withOfficerSession(
  deps: EdgeDeps,
  operationId: EdgeOperationId,
  handler: OfficerHandler,
): RouteHandler {
  const operation = edgeOperation(operationId);
  return async (ctx: RequestContext): Promise<HttpResult> =>
    guarded(operationId, ctx, async () => {
      const resolved = await resolveSession(deps, ctx);
      if (resolved.kind === 'ENDED') {
        auditEdge({
          action: 'EDGE_SESSION_REJECTED',
          operationId,
          correlationId: ctx.correlationId,
          reason: resolved.reason,
        });
        return sessionEnded(deps, resolved.reason);
      }
      const { session } = resolved;
      if (session.kind !== 'officer') {
        return wrongKind(deps, operationId, ctx, session.kind, 'officer');
      }
      if (session.agency === null) {
        // Structurally impossible (DB CHECK + create() guard). Treated as a dead
        // session rather than a 500: whatever produced it, the officer's next
        // correct action is to log in again.
        return sessionEnded(deps, 'revoked');
      }
      if (operation.csrf) {
        assertCsrf(
          ctx,
          deps.cookies.csrfCookieName,
          deps.config.session.handleHmacKey,
          bindingFor(session),
        );
      }
      return handler(ctx, session, session.agency);
    });
}

export function withApplicantSession(
  deps: EdgeDeps,
  operationId: EdgeOperationId,
  handler: ApplicantHandler,
): RouteHandler {
  const operation = edgeOperation(operationId);
  return async (ctx: RequestContext): Promise<HttpResult> =>
    guarded(operationId, ctx, async () => {
      const resolved = await resolveSession(deps, ctx);
      if (resolved.kind === 'ENDED') {
        auditEdge({
          action: 'EDGE_SESSION_REJECTED',
          operationId,
          correlationId: ctx.correlationId,
          reason: resolved.reason,
        });
        return sessionEnded(deps, resolved.reason);
      }
      const { session } = resolved;
      if (session.kind !== 'applicant') {
        return wrongKind(deps, operationId, ctx, session.kind, 'applicant');
      }
      if (operation.csrf) {
        assertCsrf(
          ctx,
          deps.cookies.csrfCookieName,
          deps.config.session.handleHmacKey,
          bindingFor(session),
        );
      }
      return handler(ctx, session);
    });
}

/**
 * A session probe that must not fail. Used only by GET /edge/v1/session, which
 * the SPA calls on every mount and which therefore also SEEDS the readable CSRF
 * cookie — without that, the very first login could not carry the token the
 * contract requires it to carry.
 */
export function withSessionProbe(
  deps: EdgeDeps,
  operationId: EdgeOperationId,
  handler: (ctx: RequestContext, session: EdgeSession | null) => Promise<HttpResult>,
): RouteHandler {
  return async (ctx: RequestContext): Promise<HttpResult> =>
    guarded(operationId, ctx, async () => {
      const resolved = await resolveSession(deps, ctx);
      if (resolved.kind === 'ENDED') {
        // 401 with a fresh CSRF cookie and NO session cookie. A 401 here is a
        // normal, expected answer — the SPA must be able to tell `checking` from
        // `anonymous` so it does not flash a login screen at a signed-in user.
        return {
          status: 401,
          body: { reason: resolved.reason },
          cookies: [...clearedCookies(deps.cookies), ...csrfCookieOnly(deps.cookies, newCsrfToken())]
            // clearedCookies also clears the CSRF cookie; the fresh one must win,
            // so keep the LAST Set-Cookie per name.
            .filter((cookie, index, all) => all.findIndex((c) => c.name === cookie.name) === index
              ? cookie.value !== '' || all.every((c) => c.name !== cookie.name || c.value === '')
              : false),
        };
      }
      return handler(ctx, resolved.session);
    });
}
