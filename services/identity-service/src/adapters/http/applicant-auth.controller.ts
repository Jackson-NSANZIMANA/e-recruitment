// ══════════════════════════════════════════════════════════════════
// identity-service — HTTP ingress for applicant authentication (ADR-018)
//
// Five routes, three auth postures:
//   • otp/request, otp/verify — PUBLIC (they are what authenticates a
//     citizen, so they cannot demand a token) with iam-grade discipline:
//     shape errors → 400; everything else about otp/request is one uniform
//     202 (no enumeration), everything failing in otp/verify is one
//     byte-identical 401.
//   • me/applications, me/applications/withdraw (ADR-020), logout —
//     SESSION-authenticated: the opaque DB session token as a Bearer
//     (owner D5), validated live against applicant_sessions (revocation
//     honoured immediately).
//
// The raw NID is request-only; the raw phone and the plaintext code never
// appear in ANY response. The session token appears exactly once — in the
// verify success body — and is never logged.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { APPLICATION_CHANNELS, type ApplicationChannel } from '@usrp/shared-types';
import {
  IdentityPersistenceError,
  InvalidNationalIdError,
  NidaUnavailableError,
  UpstreamUnavailableError,
} from '../../domain/identity.errors.js';
import type { ApplicantAuthService } from '../../application/applicant-auth.service.js';
import type { ApplicationsGateway } from '../../ports/applications-gateway.js';

export const OTP_REQUEST_PATH = '/v1/applicants/auth/otp/request';
export const OTP_VERIFY_PATH = '/v1/applicants/auth/otp/verify';
export const ME_APPLICATIONS_PATH = '/v1/applicants/me/applications';
export const ME_WITHDRAW_PATH = '/v1/applicants/me/applications/withdraw';
export const LOGOUT_PATH = '/v1/applicants/auth/logout';

const CHANNELS: ReadonlySet<string> = new Set(APPLICATION_CHANNELS);
const MAX_NID = 32;
const MAX_OTP = 12;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface OtpRequestBody {
  readonly nationalId?: unknown;
  readonly channel?: unknown;
}

interface OtpVerifyBody {
  readonly nationalId?: unknown;
  readonly otp?: unknown;
  readonly channel?: unknown;
}

interface WithdrawBody {
  readonly applicationId?: unknown;
}

/** All four applicant-auth routes, bound to the use case + gateway. */
export function applicantAuthRoutes(
  service: ApplicantAuthService,
  applications: ApplicationsGateway,
): Route[] {
  return [
    {
      method: 'POST',
      path: OTP_REQUEST_PATH,
      handler: async (ctx): Promise<HttpResult> => {
        const body = await ctx.json<OtpRequestBody>();
        const nationalId = requireNid(body.nationalId);
        const channel = requireChannel(body.channel);
        try {
          await service.requestOtp({
            rawNationalId: nationalId,
            channel,
            context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
          });
        } catch (err) {
          throw mapDomainError(err);
        }
        // Uniform 202 whatever happened internally — no enumeration.
        return { status: 202, body: { status: 'CHALLENGED' } };
      },
    },
    {
      method: 'POST',
      path: OTP_VERIFY_PATH,
      handler: async (ctx): Promise<HttpResult> => {
        const body = await ctx.json<OtpVerifyBody>();
        const nationalId = requireNid(body.nationalId);
        const channel = requireChannel(body.channel);
        const otp = body.otp;
        if (typeof otp !== 'string' || otp.length === 0 || otp.length > MAX_OTP) {
          throw new HttpError(400, 'INVALID_REQUEST', 'Field "otp" is required.');
        }
        let outcome;
        try {
          outcome = await service.verifyOtp({
            rawNationalId: nationalId,
            otp,
            channel,
            context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
          });
        } catch (err) {
          throw mapDomainError(err);
        }
        if (outcome.kind === 'INVALID_OTP') {
          throw new HttpError(401, 'INVALID_OTP', 'Invalid or expired code.');
        }
        return { status: 200, body: { sessionToken: outcome.sessionToken, expiresAt: outcome.expiresAt } };
      },
    },
    {
      method: 'GET',
      path: ME_APPLICATIONS_PATH,
      handler: async (ctx): Promise<HttpResult> => {
        const applicantId = await authenticate(authHeader(ctx.headers['authorization']), service);
        let list;
        try {
          list = await applications.listForApplicant(applicantId);
        } catch (err) {
          throw mapDomainError(err);
        }
        return { status: 200, body: { applications: list } };
      },
    },
    {
      method: 'POST',
      path: ME_WITHDRAW_PATH,
      handler: async (ctx): Promise<HttpResult> => {
        const applicantId = await authenticate(authHeader(ctx.headers['authorization']), service);
        const body = await ctx.json<WithdrawBody>();
        const applicationId = body.applicationId;
        if (typeof applicationId !== 'string' || !UUID_RE.test(applicationId)) {
          throw new HttpError(400, 'INVALID_REQUEST', 'Field "applicationId" must be a UUID.');
        }
        let result;
        try {
          // Ownership is enforced upstream inside the write transaction —
          // the session-derived applicantId travels with the request, so
          // this door can only ever move the citizen's OWN application.
          result = await applications.withdrawApplication(applicantId, applicationId);
        } catch (err) {
          throw mapDomainError(err);
        }
        switch (result.kind) {
          case 'WITHDRAWN':
            return {
              status: 200,
              body: { status: 'WITHDRAWN', agency: result.agency, fromStatus: result.fromStatus },
            };
          case 'NO_CHANGE':
            return { status: 200, body: { status: 'NO_CHANGE', agency: result.agency } };
          case 'NOT_APPLICABLE':
            return {
              status: 409,
              body: {
                status: 'NOT_APPLICABLE',
                agency: result.agency,
                currentStatus: result.currentStatus,
              },
            };
          case 'NOT_FOUND':
            return { status: 404, body: { status: 'NOT_FOUND' } };
          default:
            return assertNever(result);
        }
      },
    },
    {
      method: 'POST',
      path: LOGOUT_PATH,
      handler: async (ctx): Promise<HttpResult> => {
        // Authenticate first so a bogus token cannot probe; then revoke.
        const header = authHeader(ctx.headers['authorization']);
        const token = bearer(header);
        await authenticate(header, service);
        try {
          await service.logout(token);
        } catch (err) {
          throw mapDomainError(err);
        }
        return { status: 204 };
      },
    },
  ];
}

/** Node's IncomingHttpHeaders value → the single header string (or null). */
function authHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Extract the Bearer token or 401 — one shape for every session failure. */
function bearer(header: string | null): string {
  const value = header ?? '';
  if (!value.startsWith('Bearer ') || value.length <= 7) {
    throw new HttpError(401, 'INVALID_SESSION', 'A valid session token is required.');
  }
  return value.slice(7);
}

/** Resolve a live session to its applicant, or one uniform 401. */
async function authenticate(header: string | null, service: ApplicantAuthService): Promise<string> {
  const token = bearer(header);
  let applicantId: string | null;
  try {
    applicantId = await service.authenticateSession(token);
  } catch (err) {
    throw mapDomainError(err);
  }
  if (applicantId === null) {
    throw new HttpError(401, 'INVALID_SESSION', 'A valid session token is required.');
  }
  return applicantId;
}

function requireNid(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_NID) {
    throw new HttpError(400, 'INVALID_REQUEST', 'Field "nationalId" is required.');
  }
  return value;
}

function requireChannel(value: unknown): ApplicationChannel {
  if (typeof value !== 'string' || !CHANNELS.has(value)) {
    throw new HttpError(400, 'INVALID_CHANNEL', `Field "channel" must be one of: ${[...CHANNELS].join(', ')}.`);
  }
  return value as ApplicationChannel;
}

/** Infrastructure faults → HTTP; a malformed NID is a 400 shape error. */
function mapDomainError(err: unknown): HttpError {
  if (err instanceof InvalidNationalIdError) {
    return new HttpError(400, 'INVALID_NATIONAL_ID', 'Field "nationalId" is malformed.');
  }
  if (err instanceof NidaUnavailableError) {
    return new HttpError(503, 'NIDA_UNAVAILABLE', 'Identity registry unavailable; try again shortly.', { cause: err });
  }
  if (err instanceof UpstreamUnavailableError) {
    return new HttpError(502, 'UPSTREAM_UNAVAILABLE', 'A dependent service is unavailable.', { cause: err });
  }
  if (err instanceof IdentityPersistenceError) {
    return new HttpError(500, 'PERSISTENCE_ERROR', 'Could not complete the request.', { cause: err });
  }
  if (err instanceof HttpError) return err;
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled withdraw result: ${JSON.stringify(value)}`);
}
