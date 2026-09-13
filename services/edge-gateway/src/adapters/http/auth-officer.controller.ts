// ══════════════════════════════════════════════════════════════════
// edge-gateway — Officer credential exchange
//
// LOGIN returns 204 AND NO BODY. The session is read back from
// GET /edge/v1/session, so there is exactly ONE shape describing a session
// rather than two that can disagree — and the Ed25519 JWT that was just minted
// stays on this side of the wire.
//
// ONE FAILURE FOR EVERY CREDENTIAL PROBLEM. Unknown handle, wrong password,
// disabled account, malformed field: all bare-bodied. The frontend's
// `AuthAttempt` type has a single `rejected` case with no detail field, so it
// physically cannot render a message that distinguishes them. Adding a code here
// would re-enable account enumeration.
//
// LOGOUT DESTROYS THE SESSION SERVER-SIDE. Clearing the cookie alone is not
// logout: per ADR-016 the officer JWT is non-revocable until it expires, so if
// the handle outlives the logout there is nothing else to fall back on. This is
// the only revocation point an officer has.
// ══════════════════════════════════════════════════════════════════

import type { HttpResult, RequestContext, Route } from '@usrp/shared-http';
import { clearedCookies } from './cookies.js';
import { csrfAccepted } from './csrf.js';
import type { EdgeDeps } from './deps.js';
import { faultToResult, publicRoute, readHandle } from './guard.js';
import { EDGE_PATHS } from './paths.js';
import { bareError, csrfRejected, rateLimited, upstreamUnavailable } from './responses.js';
import { issuedCookies } from './session.controller.js';
import { containsForbiddenField, readBoundedString } from './validate.js';

const MAX_HANDLE = 128; // officer_accounts.login_handle is varchar(128)
const MAX_PASSWORD = 256;

export function officerAuthRoutes(deps: EdgeDeps): Route[] {
  return [
    {
      method: 'POST',
      path: EDGE_PATHS.officerLogin,
      handler: publicRoute(deps, async (ctx: RequestContext): Promise<HttpResult> => {
        const body = await ctx.json<unknown>();
        if (containsForbiddenField(body)) return bareError(400);
        const loginHandle = readBoundedString(body, 'loginHandle', MAX_HANDLE);
        const password = readBoundedString(body, 'password', MAX_PASSWORD);
        // A shape error is the SAME bare body as a wrong password — "that handle
        // is too long to exist here" is still information.
        if (loginHandle === null || password === null) return bareError(400);

        // The login handle is the rate-limit subject: many addresses converging
        // on one account is exactly the attack the per-client budget misses.
        if (!deps.limiter.allow(EDGE_PATHS.officerLogin, ctx.headers, loginHandle.toLowerCase())) {
          return rateLimited();
        }

        const outcome = await deps.iam.officerLogin(loginHandle, password, {
          correlationId: ctx.correlationId,
        });
        if (outcome.kind === 'REJECTED') return bareError(401);

        const issued = await deps.sessions.openOfficerSession(outcome.token, outcome.expiresAt);
        if (issued === null) {
          // iam-service handed back an already-expired token. Not the operator's
          // fault and not a credential problem — report it as an upstream fault.
          return upstreamUnavailable('UPSTREAM_UNAVAILABLE');
        }
        return {
          status: 204,
          cookies: issuedCookies(
            issued.handle,
            issued.csrfToken,
            deps.secureCookies,
            issued.maxAgeSeconds,
          ),
        };
      }),
    },
    {
      method: 'POST',
      path: EDGE_PATHS.officerLogout,
      handler: (ctx: RequestContext): Promise<HttpResult> => logout(deps, ctx),
    },
  ];
}

/**
 * Shared by both logout routes.
 *
 * IDEMPOTENT BY CONSTRUCTION: with no handle there is no state to change, so it
 * answers 204 without demanding a CSRF token. A client retrying a logout must
 * never be told it failed — and the retry happens exactly when the cookies are
 * already gone, which is precisely when a CSRF check could not pass.
 *
 * With a handle present, the CSRF check DOES apply: destroying someone's session
 * from a third-party page is a real (if petty) cross-site write.
 */
export async function logout(deps: EdgeDeps, ctx: RequestContext): Promise<HttpResult> {
  const secure = deps.secureCookies;
  const handle = readHandle(ctx, secure);
  if (handle === undefined) return { status: 204, cookies: clearedCookies(secure) };

  let storedCsrf: string | null = null;
  let applicantCredential: string | null = null;
  try {
    const lookup = await deps.sessions.peek(handle);
    if (lookup.kind === 'LIVE') {
      storedCsrf = lookup.session.csrfToken;
      if (lookup.session.kind === 'applicant') applicantCredential = lookup.session.credential;
    }
  } catch (err) {
    const mapped = faultToResult(err, secure);
    if (mapped !== null) return mapped;
    throw err;
  }
  if (!csrfAccepted(ctx, secure, storedCsrf)) return csrfRejected();

  if (applicantCredential !== null) {
    // ADR-018 chose a REVOCABLE citizen token so a stolen session could be
    // killed. Revoke it upstream as well as locally — only clearing the cookie
    // would waste the property the DB round trip is paying for.
    await deps.identity
      .revokeApplicantSession(applicantCredential, { correlationId: ctx.correlationId })
      .catch(() => undefined);
  }
  // Destroy the handle whatever happened upstream: a logout that leaves the edge
  // still holding a live credential is not a logout.
  await deps.sessions.destroy(handle);
  return { status: 204, cookies: clearedCookies(secure) };
}
