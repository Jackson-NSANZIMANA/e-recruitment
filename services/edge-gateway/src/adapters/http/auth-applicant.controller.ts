// ══════════════════════════════════════════════════════════════════
// edge-gateway — Citizen OTP authentication
//
// `202` MEANS THE REQUEST WAS ACCEPTED. NOTHING MORE.
//
// It does not indicate that the National ID exists, that a citizen record was
// found, or that an SMS was sent. Any of those turns an unauthenticated,
// nationally-reachable endpoint into a bulk identity-enumeration channel:
// submit a candidate NID, read the response, learn whether a real person is
// behind it. The deprecated frontend architecture doc specified a green
// checkmark on National-ID field blur; that is rejected and no endpoint here
// will ever feed one.
//
// The rate limiter is part of THIS property, not a hardening extra: a body that
// reveals nothing per request still reveals plenty at volume.
//
// Same reasoning as withholding a document's forensic verdict from the person
// who uploaded it — a rule the previous architect applied correctly to
// documents and inverted for National IDs four days later.
// ══════════════════════════════════════════════════════════════════

import type { HttpResult, RequestContext, Route } from '@usrp/shared-http';
import { toPlatformChannel } from './channel.js';
import type { EdgeDeps } from './deps.js';
import { publicRoute } from './guard.js';
import { logout } from './auth-officer.controller.js';
import { EDGE_PATHS } from './paths.js';
import { bareAccepted, bareError, rateLimited, upstreamUnavailable } from './responses.js';
import { issuedCookies } from './session.controller.js';
import { containsForbiddenField, readNationalId, readOtp } from './validate.js';

function channelOf(body: unknown): unknown {
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)['channel']
    : undefined;
}

export function applicantAuthRoutes(deps: EdgeDeps): Route[] {
  return [
    {
      method: 'POST',
      path: EDGE_PATHS.otpRequest,
      handler: publicRoute(deps, async (ctx: RequestContext): Promise<HttpResult> => {
        const body = await ctx.json<unknown>();
        // A body carrying a client-computed identity hash is REFUSED, not
        // sanitised — see validate.ts.
        if (containsForbiddenField(body)) return bareError(400);
        const nationalId = readNationalId(body);
        const channel = toPlatformChannel(channelOf(body));
        // STRUCTURALLY invalid only. This must never distinguish "well-formed
        // but unknown", which would restore the oracle the 202 exists to close.
        if (nationalId === null || channel === null) return bareError(400);

        if (!deps.limiter.allow(EDGE_PATHS.otpRequest, ctx.headers, nationalId)) {
          return rateLimited();
        }

        const outcome = await deps.identity.requestOtp(nationalId, channel, {
          correlationId: ctx.correlationId,
        });
        // Even MALFORMED collapses to the same bare 400 the shape check emits.
        if (outcome === 'MALFORMED') return bareError(400);
        return bareAccepted();
      }),
    },
    {
      method: 'POST',
      path: EDGE_PATHS.otpVerify,
      handler: publicRoute(deps, async (ctx: RequestContext): Promise<HttpResult> => {
        const body = await ctx.json<unknown>();
        if (containsForbiddenField(body)) return bareError(400);
        const nationalId = readNationalId(body);
        const otp = readOtp(body);
        const channel = toPlatformChannel(channelOf(body));
        if (nationalId === null || otp === null || channel === null) return bareError(400);

        if (!deps.limiter.allow(EDGE_PATHS.otpVerify, ctx.headers, nationalId)) {
          return rateLimited();
        }

        const outcome = await deps.identity.verifyOtp(nationalId, otp, channel, {
          correlationId: ctx.correlationId,
        });
        // Wrong code, expired code, locked challenge, unknown citizen: one 401.
        if (outcome.kind === 'REJECTED') return bareError(401);

        const issued = await deps.sessions.openApplicantSession(outcome.token, outcome.expiresAt);
        if (issued === null) return upstreamUnavailable('UPSTREAM_UNAVAILABLE');
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
      path: EDGE_PATHS.applicantLogout,
      // Shares the officer implementation: it revokes the opaque token upstream
      // when the session is a citizen's, and destroys the handle either way.
      handler: (ctx: RequestContext): Promise<HttpResult> => logout(deps, ctx),
    },
  ];
}
