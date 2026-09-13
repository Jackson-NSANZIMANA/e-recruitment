// ══════════════════════════════════════════════════════════════════
// edge-gateway — The session guard
//
// shared-http is deliberately a "moves bytes at the edge" substrate with no
// middleware concept, so authorization is composed at route assembly — the same
// shape as shared-auth's `withAuth` for internal services.
//
// ORDER IS DELIBERATE:
//   1. handle → session, sliding the idle window in the store's own statement;
//   2. CSRF, against the token STORED WITH THE SESSION;
//   3. session KIND.
//
// CSRF before the kind check because a forged cross-site request should be
// refused before it learns anything at all about the session it rode in on.
//
// AND ONE THING THE GUARD OWNS THAT NO CONTROLLER SHOULD REPEAT: when an
// upstream rejects the credential the edge is holding, the handle is DESTROYED
// and the cookies cleared. That is how ADR-018's revocable citizen token and
// ADR-016's expiring officer JWT actually reach the browser, instead of the
// browser holding a handle that looks alive and 500s forever.
// ══════════════════════════════════════════════════════════════════

import type { HttpResult, RequestContext, RouteHandler } from '@usrp/shared-http';
import {
  SessionStoreError,
  UpstreamCredentialRejected,
  UpstreamError,
} from '../../domain/errors.js';
import type { EdgeSession } from '../../domain/session.js';
import type { EdgeSessionService } from '../../application/session.service.js';
import { clearedCookies, cookieNames } from './cookies.js';
import { csrfAccepted } from './csrf.js';
import {
  codedError,
  csrfRejected,
  sessionEnded,
  upstreamUnavailable,
  wrongSessionKind,
} from './responses.js';

export type OfficerEdgeSession = Extract<EdgeSession, { readonly kind: 'officer' }>;
export type ApplicantEdgeSession = Extract<EdgeSession, { readonly kind: 'applicant' }>;

export interface GuardDeps {
  readonly sessions: EdgeSessionService;
  readonly secureCookies: boolean;
}

/** Read the opaque handle from the httpOnly cookie. */
export function readHandle(ctx: RequestContext, secureCookies: boolean): string | undefined {
  return ctx.cookies.get(cookieNames(secureCookies).session);
}

/**
 * Map an upstream/infra fault onto the contract's error bodies.
 *
 * A named G2G authority survives (`NIDA_UNAVAILABLE` is actionable copy); a
 * session-store fault is a 503 because the edge genuinely cannot serve, not a
 * 500 that invites a retry loop against a broken dependency.
 */
export function faultToResult(err: unknown, secureCookies: boolean): HttpResult | null {
  if (err instanceof UpstreamCredentialRejected) {
    return { ...sessionEnded(err.reason), cookies: clearedCookies(secureCookies) };
  }
  if (err instanceof UpstreamError) return upstreamUnavailable(err.authority);
  if (err instanceof SessionStoreError) {
    return codedError(503, 'SESSION_STORE_UNAVAILABLE', 'The session store is unavailable.');
  }
  return null;
}

function guard(
  deps: GuardDeps,
  kind: EdgeSession['kind'],
  handler: (ctx: RequestContext, session: EdgeSession) => Promise<HttpResult>,
): RouteHandler {
  return async (ctx: RequestContext): Promise<HttpResult> => {
    const handle = readHandle(ctx, deps.secureCookies);
    // No cookie at all: no reason is reported, because "you were away too long"
    // is the wrong thing to tell someone who never signed in.
    if (handle === undefined) return sessionEnded();

    let session: EdgeSession;
    try {
      const lookup = await deps.sessions.touch(handle);
      if (lookup.kind === 'NONE') {
        // A cookie pointing at a session that no longer exists. Clear it, or
        // every subsequent request repeats this round trip.
        return { ...sessionEnded('revoked'), cookies: clearedCookies(deps.secureCookies) };
      }
      if (lookup.kind === 'ENDED') {
        return { ...sessionEnded(lookup.reason), cookies: clearedCookies(deps.secureCookies) };
      }
      session = lookup.session;
    } catch (err) {
      const mapped = faultToResult(err, deps.secureCookies);
      if (mapped !== null) return mapped;
      throw err;
    }

    if (!csrfAccepted(ctx, deps.secureCookies, session.csrfToken)) return csrfRejected();
    if (session.kind !== kind) return wrongSessionKind();

    try {
      return await handler(ctx, session);
    } catch (err) {
      if (err instanceof UpstreamCredentialRejected) {
        // The credential behind this handle is dead. Destroying the handle is
        // the point: it makes upstream revocation visible at the browser.
        await deps.sessions.destroy(handle).catch(() => undefined);
      }
      const mapped = faultToResult(err, deps.secureCookies);
      if (mapped !== null) return mapped;
      throw err;
    }
  };
}

export function withOfficerSession(
  deps: GuardDeps,
  handler: (ctx: RequestContext, session: OfficerEdgeSession) => Promise<HttpResult>,
): RouteHandler {
  return guard(deps, 'officer', (ctx, session) => handler(ctx, session as OfficerEdgeSession));
}

export function withApplicantSession(
  deps: GuardDeps,
  handler: (ctx: RequestContext, session: ApplicantEdgeSession) => Promise<HttpResult>,
): RouteHandler {
  return guard(deps, 'applicant', (ctx, session) => handler(ctx, session as ApplicantEdgeSession));
}

/**
 * A route on the public allowlist. No session, but the CSRF double-submit still
 * applies (against the readable cookie) and upstream faults still map to the
 * contract's bodies.
 */
export function publicRoute(
  deps: GuardDeps,
  handler: (ctx: RequestContext) => Promise<HttpResult>,
): RouteHandler {
  return async (ctx: RequestContext): Promise<HttpResult> => {
    if (!csrfAccepted(ctx, deps.secureCookies, null)) return csrfRejected();
    try {
      return await handler(ctx);
    } catch (err) {
      const mapped = faultToResult(err, deps.secureCookies);
      if (mapped !== null) return mapped;
      throw err;
    }
  };
}
