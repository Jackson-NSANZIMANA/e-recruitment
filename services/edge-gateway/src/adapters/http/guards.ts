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
//   3. Wrong session KIND is 403, never 401. The caller IS authenticated; the
//      two credentials are simply not interchangeable (ADR-016 vs ADR-018). A
//      401 would send the SPA into a login loop it can never win.
//
// A dead or unknown handle always ships CLEARED COOKIES with its 401.
//
// EdgeDeps IS DECLARED HERE, ONCE, AND IS TYPED ON PORTS. It used to be
// declared twice (here and in index.ts) and typed on the concrete
// PgEdgeSessionStore / UpstreamClient / FixedWindowRateLimiter classes, which
// made every controller depend on Postgres and fetch by type.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type RequestContext, type RouteHandler } from '@usrp/shared-http';
import type { Agency } from '@usrp/shared-types';
import { edgeOperation, type EdgeOperationId } from '../../domain/edge-operations.js';
import type { EdgeSession, SessionEndedReason } from '../../domain/session.types.js';
import { UpstreamUnavailableError } from '../../domain/edge.errors.js';
import type { EdgeGatewayConfig } from '../../config.js';
import type { AuditLogger } from '../../ports/audit-logger.js';
import type { RateLimiter } from '../../ports/rate-limiter.js';
import type { SessionRepository } from '../../ports/session-repository.js';
import type { UpstreamGateway } from '../../ports/upstream-gateway.js';
import { anonymousProbeCookies, clearedCookies, type CookiePolicy } from './cookies.js';
import { assertCsrf, newCsrfToken, type CsrfBinding } from './csrf.js';
import { ForbiddenFieldError } from './validation.js';

/** The dependency bundle every edge route closes over. Ports only. */
export interface EdgeDeps {
  readonly config: EdgeGatewayConfig;
  readonly cookies: CookiePolicy;

  // Driven ports (secondary adapters)
  readonly sessions: SessionRepository;
  readonly upstream: UpstreamGateway;
  readonly limiter: RateLimiter;
  readonly audit: AuditLogger;

  readonly now: () => Date;
}

export type OfficerHandler = (
  ctx: RequestContext,
  session: EdgeSession,
  agency: Agency,
) => Promise<HttpResult>;

export type ApplicantHandler = (ctx: RequestContext, session: EdgeSession) => Promise<HttpResult>;

export type AnonymousHandler = (ctx: RequestContext) => Promise<HttpResult>;

/** A handler that must work with or without a session. Probe and logout only. */
export type OptionalSessionHandler = (
  ctx: RequestContext,
  session: EdgeSession | null,
  endedReason: SessionEndedReason | null,
) => Promise<HttpResult>;

export function csrfBindingFor(session: EdgeSession): CsrfBinding {
  return { currentHash: session.csrfTokenHash, previousHash: session.previousCsrfTokenHash };
}

/** The contract's 401: a `reason` the UI can turn into a true sentence. */
export function sessionEnded(deps: EdgeDeps, reason: SessionEndedReason): HttpResult {
  return { status: 401, body: { reason }, cookies: clearedCookies(deps.cookies) };
}

/**
 * Translate anything a handler throws into a browser-safe result.
 *
 * UpstreamUnavailableError becomes the contract's G2GError — body `{ error }`
 * and nothing else, because "the national ID registry is unavailable" is
 * actionable while an upstream stack detail is a leak. The edge's OWN stores
 * (the rate limiter) fail CLOSED as a 503 too, never open.
 */
async function guarded(
  deps: EdgeDeps,
  operationId: EdgeOperationId,
  ctx: RequestContext,
  run: () => Promise<HttpResult>,
): Promise<HttpResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof UpstreamUnavailableError) {
      deps.audit.log({
        action: 'EDGE_UPSTREAM_UNAVAILABLE',
        operationId,
        correlationId: ctx.correlationId,
        reason: err.code,
        detail: { upstream: err.upstreamOperationId },
      });
      return { status: 503, body: { error: err.code } };
    }
    if (err instanceof ForbiddenFieldError) {
      deps.audit.log({
        action: 'EDGE_FORBIDDEN_FIELD_REJECTED',
        operationId,
        correlationId: ctx.correlationId,
        detail: { field: err.field },
      });
      throw err;
    }
    if (err instanceof HttpError) {
      if (err.code === 'CSRF_REJECTED') {
        deps.audit.log({ action: 'EDGE_CSRF_REJECTED', operationId, correlationId: ctx.correlationId });
      } else if (err.code === 'RATE_LIMITED') {
        deps.audit.log({ action: 'EDGE_RATE_LIMITED', operationId, correlationId: ctx.correlationId });
      } else if (err.code === 'RATE_LIMITER_UNAVAILABLE') {
        deps.audit.log({
          action: 'EDGE_RATE_LIMITER_UNAVAILABLE',
          operationId,
          correlationId: ctx.correlationId,
        });
      }
      throw err;
    }
    throw err;
  }
}

export type ResolvedSession =
  | { readonly kind: 'ACTIVE'; readonly session: EdgeSession }
  | { readonly kind: 'ENDED'; readonly reason: SessionEndedReason };

async function resolveSession(deps: EdgeDeps, ctx: RequestContext): Promise<ResolvedSession> {
  const handle = ctx.cookies.get(deps.cookies.sessionCookieName);
  if (handle === undefined || handle.length === 0) {
    // No cookie at all reports as `revoked`: an absent handle and a destroyed
    // one are the same fact from the browser's side.
    return { kind: 'ENDED', reason: 'revoked' };
  }
  const lookup = await deps.sessions.findByHandle(handle, deps.now());
  if (lookup.kind === 'ACTIVE') return { kind: 'ACTIVE', session: lookup.session };
  // UNKNOWN and revoked report identically — a handle-existence oracle would
  // let an attacker confirm that a stolen handle was once real.
  return { kind: 'ENDED', reason: lookup.kind === 'UNKNOWN' ? 'revoked' : lookup.reason };
}

function wrongKind(
  deps: EdgeDeps,
  operationId: EdgeOperationId,
  ctx: RequestContext,
  actual: string,
  required: string,
): HttpResult {
  deps.audit.log({
    action: 'EDGE_WRONG_SESSION_KIND',
    operationId,
    correlationId: ctx.correlationId,
    sessionKind: actual,
    reason: `requires:${required}`,
  });
  return { status: 403, body: { error: 'WRONG_SESSION_KIND' } };
}

/**
 * Anonymous operations. CSRF is still enforced when the registry says so, using
 * pure double-submit — there is no session half to bind to yet, which is
 * exactly why these operations are also the rate-limited ones.
 */
export function withAnonymous(
  deps: EdgeDeps,
  operationId: EdgeOperationId,
  handler: AnonymousHandler,
): RouteHandler {
  const operation = edgeOperation(operationId);
  return async (ctx: RequestContext): Promise<HttpResult> =>
    guarded(deps, operationId, ctx, async () => {
      if (operation.csrf) {
        assertCsrf(ctx, deps.cookies.csrfCookieName, deps.config.session.handleHmacKey, null);
      }
      return handler(ctx);
    });
}

export function withOfficerSession(
  deps: EdgeDeps,
  operationId: EdgeOperationId,
  handler: OfficerHandler,
): RouteHandler {
  const operation = edgeOperation(operationId);
  return async (ctx: RequestContext): Promise<HttpResult> =>
    guarded(deps, operationId, ctx, async () => {
      const resolved = await resolveSession(deps, ctx);
      if (resolved.kind === 'ENDED') {
        deps.audit.log({
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
      const { agency } = session;
      if (agency === null) {
        // Structurally impossible (DB CHECK + create() guard). Treated as a dead
        // session rather than a 500: the officer's correct next action is to
        // log in again.
        return sessionEnded(deps, 'revoked');
      }
      if (operation.csrf) {
        assertCsrf(
          ctx,
          deps.cookies.csrfCookieName,
          deps.config.session.handleHmacKey,
          csrfBindingFor(session),
        );
      }
      return handler(ctx, session, agency);
    });
}

export function withApplicantSession(
  deps: EdgeDeps,
  operationId: EdgeOperationId,
  handler: ApplicantHandler,
): RouteHandler {
  const operation = edgeOperation(operationId);
  return async (ctx: RequestContext): Promise<HttpResult> =>
    guarded(deps, operationId, ctx, async () => {
      const resolved = await resolveSession(deps, ctx);
      if (resolved.kind === 'ENDED') {
        deps.audit.log({
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
          csrfBindingFor(session),
        );
      }
      return handler(ctx, session);
    });
}

/**
 * For the operations that must behave sanely WITHOUT a session:
 *
 *   readSession  a 401 is a normal, expected answer — the SPA must be able to
 *                tell `checking` from `anonymous`. It also seeds the CSRF cookie.
 *   logout       idempotent by contract: "no session" is a 204, not a 401.
 *
 * CSRF still applies when the registry demands it, bound to the session when
 * there is one and double-submit only when there is not.
 */
export function withOptionalSession(
  deps: EdgeDeps,
  operationId: EdgeOperationId,
  handler: OptionalSessionHandler,
): RouteHandler {
  const operation = edgeOperation(operationId);
  return async (ctx: RequestContext): Promise<HttpResult> =>
    guarded(deps, operationId, ctx, async () => {
      const resolved = await resolveSession(deps, ctx);
      const session = resolved.kind === 'ACTIVE' ? resolved.session : null;
      if (operation.csrf && (session !== null || !operation.idempotentWithoutSession)) {
        assertCsrf(
          ctx,
          deps.cookies.csrfCookieName,
          deps.config.session.handleHmacKey,
          session === null ? null : csrfBindingFor(session),
        );
      }
      return handler(ctx, session, resolved.kind === 'ENDED' ? resolved.reason : null);
    });
}

/** The anonymous answer from the session probe: no session, fresh CSRF token. */
export function anonymousProbeResult(deps: EdgeDeps, reason: SessionEndedReason): HttpResult {
  return {
    status: 401,
    body: { reason },
    cookies: anonymousProbeCookies(deps.cookies, newCsrfToken()),
  };
}
