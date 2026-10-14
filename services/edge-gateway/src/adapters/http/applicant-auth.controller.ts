// ══════════════════════════════════════════════════════════════════
// edge-gateway — Citizen OTP authentication
//
// `202` MEANS THE REQUEST WAS ACCEPTED. NOTHING MORE.
//
// (OTP request) It does not indicate that an SMS was sent. The 202 body is
// byte-identical for every well-formed request. The only 400s are a
// structurally invalid token/phone; an expired token is 401.
//
// The identity step (National ID + DOB) DOES tell the caller whether the
// details matched NIDA — that is the point of confirming citizenship before
// asking for a phone — so it is DOB-gated, answers one body for every
// non-match, and is rate limited hard per National ID and per client.
// Rate limiting is a correctness requirement here rather than hardening, and
// in production the counters are SHARED across replicas.
//
// CHANNEL IS SERVER-SET. Only WEB describes a browser; USSD arrives from a telco
// gateway and IREMBO_KIOSK from a kiosk integration, so `channel` is not in the
// request schema at all.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type RouteHandler } from '@usrp/shared-http';
import { UPSTREAM } from '../../domain/upstream-operations.js';
import { clearedCookies, sessionCookies } from './cookies.js';
import { clientBucketKey, enforceRateLimit, targetBucketKey } from './rate-limit.js';
import { field } from './projections.js';
import { CREDENTIAL_REJECTED } from './outcomes.js';
import { withAnonymous, withOptionalSession, type EdgeDeps } from './guards.js';
import {
  readJsonBody,
  requireDateOfBirth,
  requireNationalId,
  requirePhoneNumberShape,
} from './validation.js';

/** The browser is the WEB channel. It does not get to claim another one. */
const BROWSER_CHANNEL = 'WEB';
const OTP_RE = /^\d{6}$/;
/** Onboarding-begin attempts per National ID per minute (DOB is guessable). */
const ONBOARDING_BEGIN_PER_NID_PER_MINUTE = 5;

function requireOnboardingToken(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new HttpError(400, 'INVALID_REQUEST', 'An onboarding token is required.');
  }
  return value;
}

/**
 * Step 1 — National ID + date of birth.
 *
 * The DOB is a SECOND FACTOR taken from NIDA's own record: since the OTP only
 * proves control of a phone the citizen names, this is what stops someone who
 * merely knows a National ID from enrolling their own phone against it. The
 * answer is one body for unknown NID, non-citizen and DOB mismatch.
 *
 * Because DOB is guessable by enumeration, the per-NID bucket here is far
 * stricter than the OTP buckets. A per-minute window is still not a durable
 * lockout; that counter belongs in identity-service's store (tracked).
 */
export function beginApplicantOnboardingHandler(deps: EdgeDeps): RouteHandler {
  return withAnonymous(deps, 'beginApplicantOnboarding', async (ctx) => {
    const body = await readJsonBody(ctx);
    const nationalId = requireNationalId(body.nationalId);
    const dateOfBirth = requireDateOfBirth(body.dateOfBirth);

    const limits = deps.config.rateLimits;
    const key = deps.config.session.handleHmacKey;
    await enforceRateLimit(
      deps.limiter,
      targetBucketKey(key, 'onboardingBegin', nationalId),
      Math.min(limits.otpPerMinute, ONBOARDING_BEGIN_PER_NID_PER_MINUTE),
    );
    await enforceRateLimit(
      deps.limiter,
      `${clientBucketKey(ctx, limits.trustedProxyHops)}:onboardingBegin`,
      limits.otpPerMinute,
    );

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.onboardingBegin,
      correlationId: ctx.correlationId,
      body: { nationalId, dateOfBirth, channel: BROWSER_CHANNEL },
    });

    if (upstream.status === 200) {
      const onboardingToken = field(upstream.body, 'onboardingToken');
      const expiresAt = field(upstream.body, 'expiresAt');
      if (typeof onboardingToken !== 'string' || onboardingToken.length === 0) {
        return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
      }
      return {
        status: 200,
        body: { onboardingToken, expiresAt: typeof expiresAt === 'string' ? expiresAt : null },
      };
    }
    if (upstream.status === 422) {
      return { status: 422, body: { error: 'IDENTITY_NOT_CONFIRMED' } };
    }
    if (upstream.status === 400) return { status: 400, body: { error: 'INVALID_REQUEST' } };
    return { status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } };
  });
}

/** Step 2 — the phone number the citizen states; the OTP is sent THERE. */
export function requestApplicantOtpHandler(deps: EdgeDeps): RouteHandler {
  return withAnonymous(deps, 'requestApplicantOtp', async (ctx) => {
    const body = await readJsonBody(ctx);
    const onboardingToken = requireOnboardingToken(body.onboardingToken);
    const phoneNumber = requirePhoneNumberShape(body.phoneNumber);

    const limits = deps.config.rateLimits;
    const key = deps.config.session.handleHmacKey;
    // Keyed on the TOKEN as well as the number: one confirmed identity cannot
    // be used to SMS-bomb many numbers, and one number cannot be flooded from
    // many identities.
    await enforceRateLimit(deps.limiter, targetBucketKey(key, 'otp', onboardingToken), limits.otpPerMinute);
    await enforceRateLimit(deps.limiter, targetBucketKey(key, 'otpPhone', phoneNumber), limits.otpPerMinute);
    await enforceRateLimit(
      deps.limiter,
      `${clientBucketKey(ctx, limits.trustedProxyHops)}:otp`,
      limits.otpPerMinute,
    );

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.otpRequest,
      correlationId: ctx.correlationId,
      body: { onboardingToken, phoneNumber, channel: BROWSER_CHANNEL },
    });

    if (upstream.status === 202 || upstream.status === 200) {
      return { status: 202, body: { accepted: true } };
    }
    if (upstream.status === 401) {
      return { status: 401, body: { error: 'ONBOARDING_EXPIRED' } };
    }
    if (upstream.status === 400) {
      const code = field(upstream.body, 'error');
      return {
        status: 400,
        body: { error: code === 'INVALID_PHONE_NUMBER' ? 'INVALID_PHONE_NUMBER' : 'INVALID_REQUEST' },
      };
    }
    return { status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } };
  });
}

/** Step 3 — the code, bound to that number, opens the session. */
export function verifyApplicantOtpHandler(deps: EdgeDeps): RouteHandler {
  return withAnonymous(deps, 'verifyApplicantOtp', async (ctx) => {
    const body = await readJsonBody(ctx);
    const onboardingToken = requireOnboardingToken(body.onboardingToken);
    const phoneNumber = requirePhoneNumberShape(body.phoneNumber);
    const otp = body.otp;
    if (typeof otp !== 'string' || !OTP_RE.test(otp)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'A one-time code is six digits.');
    }

    const limits = deps.config.rateLimits;
    const key = deps.config.session.handleHmacKey;
    await enforceRateLimit(
      deps.limiter,
      targetBucketKey(key, 'otpVerify', onboardingToken),
      limits.otpPerMinute,
    );
    await enforceRateLimit(
      deps.limiter,
      `${clientBucketKey(ctx, limits.trustedProxyHops)}:otpVerify`,
      limits.otpPerMinute,
    );

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.otpVerify,
      correlationId: ctx.correlationId,
      body: { onboardingToken, phoneNumber, otp, channel: BROWSER_CHANNEL },
    });

    if (upstream.status !== 200) return CREDENTIAL_REJECTED;

    const sessionToken = field(upstream.body, 'sessionToken');
    const expiresAt = field(upstream.body, 'expiresAt');
    if (typeof sessionToken !== 'string' || sessionToken.length === 0) {
      return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
    }

    // No subjectId and no agency. The edge never learns WHO the citizen is, and
    // a citizen is cross-agency by construction (ADR-014, ADR-018).
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

    deps.audit.log({
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
 * handle. Idempotent by contract; an upstream revoke failure is still a 204,
 * because the edge handle (the half the browser can use) is already gone.
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
          deps.audit.fault(
            {
              event: 'EDGE_APPLICANT_UPSTREAM_REVOKE_FAILED',
              correlationId: ctx.correlationId,
              sessionId: session.sessionId,
            },
            err,
          );
        }
      }
      await deps.sessions.revoke(session.sessionId, 'applicant_logout', deps.now());
      deps.audit.log({
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
