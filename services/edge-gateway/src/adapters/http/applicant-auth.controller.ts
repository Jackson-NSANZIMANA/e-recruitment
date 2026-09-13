// ══════════════════════════════════════════════════════════════════
// edge-gateway — Citizen OTP authentication
//
// `202` MEANS THE REQUEST WAS ACCEPTED. NOTHING MORE.
//
// It does not indicate that the National ID exists, that a citizen record was
// found, or that an SMS was sent. Any of those would make this an
// unauthenticated national-identity enumeration oracle: submit a candidate NID,
// read the response, learn whether a real citizen is behind it. At national
// scale on a public endpoint that is a bulk PII disclosure channel.
//
// So the 202 body is byte-identical for every input the edge accepts, and the
// ONLY 400 is a structurally invalid National ID — never "well-formed but
// unknown", which would restore the oracle. Rate limiting is a correctness
// requirement here rather than hardening: without it the silence still leaks by
// timing and volume.
//
// CHANNEL IS SERVER-SET. The upstream channel vocabulary is
// WEB | USSD | IREMBO_KIOSK | WALK_IN, and only one of those describes a
// browser. USSD arrives from a telco gateway and IREMBO_KIOSK from a kiosk
// integration — neither is a claim a web client gets to make about itself, so
// `channel` is not in the request schema at all.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type RouteHandler } from '@usrp/shared-http';
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
import { readJsonBody, requireNationalId } from './validation.js';

/** The browser is the WEB channel. It does not get to claim another one. */
const BROWSER_CHANNEL = 'WEB';
const OTP_RE = /^\d{6}$/;

export function requestApplicantOtpHandler(deps: EdgeDeps): RouteHandler {
  return withAnonymous(deps, 'requestApplicantOtp', async (ctx) => {
    const body = await readJsonBody(ctx);
    const nationalId = requireNationalId(body.nationalId);

    const limits = deps.config.rateLimits;
    const key = deps.config.session.handleHmacKey;
    // The target key is a KEYED HASH of the National ID. A national identifier
    // must not sit in process memory as a plaintext map index — a heap dump is a
    // real disclosure channel.
    assertWithinLimit(
      deps.limiter.check(targetBucketKey(key, 'otp', nationalId), limits.otpPerMinute),
    );
    assertWithinLimit(
      deps.limiter.check(
        `${clientBucketKey(ctx, limits.trustedProxyHops)}:otp`,
        limits.otpPerMinute,
      ),
    );

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.otpRequest,
      correlationId: ctx.correlationId,
      body: { nationalId, channel: BROWSER_CHANNEL },
    });

    // ONE body, whatever happened. 202 upstream, 404-shaped internals, a citizen
    // who does not exist — all indistinguishable from here.
    if (upstream.status === 202 || upstream.status === 200) {
      return { status: 202, body: { accepted: true } };
    }
    if (upstream.status === 400) {
      // The edge already enforced 16 digits, so this is an upstream shape
      // disagreement. Reported as a bare 400 with no subject information.
      return { status: 400, body: { error: 'INVALID_REQUEST' } };
    }
    // Anything else is a dependency fault, not information about the subject.
    return { status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } };
  });
}

export function verifyApplicantOtpHandler(deps: EdgeDeps): RouteHandler {
  return withAnonymous(deps, 'verifyApplicantOtp', async (ctx) => {
    const body = await readJsonBody(ctx);
    const nationalId = requireNationalId(body.nationalId);
    const otp = body.otp;
    if (typeof otp !== 'string' || !OTP_RE.test(otp)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'A one-time code is six digits.');
    }

    const limits = deps.config.rateLimits;
    const key = deps.config.session.handleHmacKey;
    assertWithinLimit(
      deps.limiter.check(targetBucketKey(key, 'otpVerify', nationalId), limits.otpPerMinute),
    );
    assertWithinLimit(
      deps.limiter.check(
        `${clientBucketKey(ctx, limits.trustedProxyHops)}:otpVerify`,
        limits.otpPerMinute,
      ),
    );

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.otpVerify,
      correlationId: ctx.correlationId,
      body: { nationalId, otp, channel: BROWSER_CHANNEL },
    });

    if (upstream.status !== 200) return CREDENTIAL_REJECTED;

    const sessionToken = field(upstream.body, 'sessionToken');
    const expiresAt = field(upstream.body, 'expiresAt');
    if (typeof sessionToken !== 'string' || sessionToken.length === 0) {
      return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
    }

    // No subjectId and no agency. The edge never learns WHO the citizen is — the
    // opaque token is the whole of what it holds — and a citizen is cross-agency
    // by construction (ADR-014, ADR-018), so ApplicantSession has no agency.
    const issued = await deps.sessions.create(
      {
        kind: 'applicant',
        subjectId: null,
        agency: null,
        roles: [],
        upstreamCredential: sessionToken,
        upstreamExpiresAt: typeof expiresAt === 'string' ? expiresAt : null,
      },
      deps.now(),
    );

    auditEdge({
      action: 'EDGE_SESSION_ISSUED',
      operationId: 'verifyApplicantOtp',
      correlationId: ctx.correlationId,
      sessionId: issued.session.sessionId,
      sessionKind: 'applicant',
    });

    return {
      status: 204,
      cookies: sessionCookies(deps.cookies, issued.handle, issued.csrfToken),
    };
  });
}

/**
 * Citizen logout. Revokes the opaque token UPSTREAM and destroys the edge
 * handle. ADR-018 chose a revocable token precisely so a stolen session could be
 * killed; only clearing the cookie would waste that property.
 *
 * Idempotent by contract, so a missing session is a 204. An upstream revoke
 * failure is also a 204: the edge handle is already gone, which is the half the
 * browser can actually use, and telling a user their logout failed would invite
 * them to leave the page believing they are still signed in.
 */
export function logoutApplicantHandler(deps: EdgeDeps): RouteHandler {
  return withOptionalSession(deps, 'logoutApplicant', async (ctx, session) => {
    if (session !== null) {
      if (session.kind === 'applicant') {
        try {
          await deps.upstream.call({
            operation: UPSTREAM.applicantLogout,
            correlationId: ctx.correlationId,
            credential: session.upstreamCredential,
          });
        } catch (err) {
          console.error(
            JSON.stringify({
              msg: 'edge_applicant_upstream_revoke_failed',
              correlationId: ctx.correlationId,
              sessionId: session.sessionId,
            }),
            err,
          );
        }
      }
      await deps.sessions.revoke(session.sessionId, 'applicant_logout', deps.now());
      auditEdge({
        action: 'EDGE_SESSION_DESTROYED',
        operationId: 'logoutApplicant',
        correlationId: ctx.correlationId,
        sessionId: session.sessionId,
        sessionKind: session.kind,
      });
    }
    return { status: 204, cookies: clearedCookies(deps.cookies) };
  });
}
