// ══════════════════════════════════════════════════════════════════
// identity-service — HTTP ingress for applicant authentication (ADR-018)
//
// Six routes, three auth postures:
//   • otp/request, otp/verify — PUBLIC (they are what authenticates a
//     citizen, so they cannot demand a token) with iam-grade discipline:
//     shape errors → 400; everything else about otp/request is one uniform
//     202 (no enumeration), everything failing in otp/verify is one
//     byte-identical 401.
//   • me/applications (GET list, ADR-018; POST submit, ADR-027),
//     me/applications/withdraw (ADR-020), logout — SESSION-authenticated:
//     the opaque DB session token as a Bearer (owner D5), validated live
//     against applicant_sessions (revocation honoured immediately).
//
// The raw NID is request-only; the raw phone and the plaintext code never
// appear in ANY response. The session token appears exactly once — in the
// verify success body — and is never logged.
//
// SUBMIT (ADR-027): the citizen's own filing through application-service's
// idempotent front door. The subject is DERIVED from the session — a body
// `applicantId` is refused, never trusted — and the browser channel is a
// server-side fact, so a body `channel` is refused too. The caller's
// Idempotency-Key (exactly one UUID) is forwarded EXACTLY; the replay
// header is preserved on the way back so a retrying citizen can tell a
// replay from a first submission.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import {
  ALL_CATEGORIES,
  APPLICATION_CHANNELS,
  type ApplicationCategory,
  type ApplicationChannel,
} from '@usrp/shared-types';
import {
  IdentityPersistenceError,
  InvalidNationalIdError,
  NidaUnavailableError,
  UpstreamUnavailableError,
} from '../../domain/identity.errors.js';
import type { ApplicantAuthService } from '../../application/applicant-auth.service.js';
import type {
  ApplicantSubmitResult,
  ApplicationsGateway,
} from '../../ports/applications-gateway.js';

export const OTP_REQUEST_PATH = '/v1/applicants/auth/otp/request';
export const OTP_VERIFY_PATH = '/v1/applicants/auth/otp/verify';
export const ME_APPLICATIONS_PATH = '/v1/applicants/me/applications';
export const ME_WITHDRAW_PATH = '/v1/applicants/me/applications/withdraw';
export const LOGOUT_PATH = '/v1/applicants/auth/logout';

/** Request header carrying the citizen's retry identity (ADR-027). */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Response header set only when application-service replayed a stored answer. */
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

const CHANNELS: ReadonlySet<string> = new Set(APPLICATION_CHANNELS);
const CATEGORIES: ReadonlySet<string> = ALL_CATEGORIES;
/** Same bound as the edge's walk-in lane: an academic registry reference. */
const MAX_ACADEMIC_REF = 64;
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

/** Wire shape of the submit-own body — every field validated before use. */
interface SubmitOwnRequestBody {
  readonly applicantId?: unknown;
  readonly category?: unknown;
  readonly channel?: unknown;
  readonly nesaIndexNumber?: unknown;
  readonly hecRegistrationNumber?: unknown;
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
      path: ME_APPLICATIONS_PATH,
      handler: async (ctx): Promise<HttpResult> => {
        // 1. The session IS the subject. A body-supplied identity is never
        //    consulted — it is refused below so a client cannot believe it
        //    had any say in who is filing.
        const applicantId = await authenticate(authHeader(ctx.headers['authorization']), service);
        // 2. Exactly one UUID Idempotency-Key, validated before anything else
        //    — a client that cannot produce a stable key is told so rather
        //    than silently given at-least-once filing (ADR-027).
        const idempotencyKey = requireIdempotencyKey(ctx.headers[IDEMPOTENCY_KEY_HEADER]);
        const body = await ctx.json<SubmitOwnRequestBody>();
        // 3. Forged identity/channel fields are REFUSED, not ignored: an
        //    ignored authorization field is a control the caller thinks exists.
        if (body.applicantId !== undefined) {
          throw new HttpError(
            400,
            'FORBIDDEN_FIELD',
            'Field "applicantId" is derived from the session and cannot be sent.',
          );
        }
        if (body.channel !== undefined) {
          throw new HttpError(
            400,
            'FORBIDDEN_FIELD',
            'Field "channel" is not accepted; the browser channel is set by the server.',
          );
        }
        // 4. Category must be a real category (agency is derived from it
        //    upstream); academic references are optional strings here —
        //    WHICH one is required is application-service's domain rule.
        const category = requireCategory(body.category);
        const nesaIndexNumber = optionalAcademicRef(body.nesaIndexNumber, 'nesaIndexNumber');
        const hecRegistrationNumber = optionalAcademicRef(
          body.hecRegistrationNumber,
          'hecRegistrationNumber',
        );

        let result: ApplicantSubmitResult;
        try {
          result = await applications.submitForApplicant(
            applicantId,
            {
              category,
              nesaIndexNumber,
              hecRegistrationNumber,
            },
            idempotencyKey,
          );
        } catch (err) {
          throw mapDomainError(err);
        }
        return mapSubmitResult(result);
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

/**
 * Exactly one UUID `Idempotency-Key`, REQUIRED on submit.
 *
 * A repeated header arrives as an array — rejected rather than resolved by
 * picking one, because the two values denote two different requests and any
 * choice would be a guess about which retry the client meant (same posture
 * as application-service's own front door).
 */
function requireIdempotencyKey(value: string | readonly string[] | undefined): string {
  if (value === undefined) {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Header "Idempotency-Key" is required.');
  }
  if (typeof value !== 'string') {
    // A repeated header arrives as an array — rejected rather than resolved
    // by picking one, because the two values denote two different requests
    // and any choice would be a guess about which retry the client meant.
    throw new HttpError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Header "Idempotency-Key" must appear exactly once.',
    );
  }
  const key = value.trim();
  if (!UUID_RE.test(key)) {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Header "Idempotency-Key" must be a UUID.');
  }
  return key;
}

function requireCategory(value: unknown): ApplicationCategory {
  if (typeof value !== 'string' || !CATEGORIES.has(value)) {
    throw new HttpError(
      400,
      'INVALID_CATEGORY',
      'Field "category" must be a valid application category.',
    );
  }
  return value as ApplicationCategory;
}

/** An academic registry reference: optional, but a string of sane length. */
function optionalAcademicRef(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'INVALID_REQUEST', `Field "${field}" must be a string when present.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_ACADEMIC_REF) {
    throw new HttpError(
      400,
      'INVALID_REQUEST',
      `Field "${field}" must be at most ${String(MAX_ACADEMIC_REF)} characters.`,
    );
  }
  return trimmed;
}

/**
 * Typed submit outcome → HTTP. Mirrors application-service's own front-door
 * mapping: a REPLAY keeps the first submission's 201 and identifiers with
 * `Idempotency-Replayed: true`; KEY_REUSED stays identifier-free; the two
 * dependency kinds are generic 502s that never echo upstream bodies.
 */
function mapSubmitResult(result: ApplicantSubmitResult): HttpResult {
  switch (result.kind) {
    case 'SUBMITTED':
      return {
        status: 201,
        body: {
          status: 'SUBMITTED',
          applicationId: result.applicationId,
          processingCode: result.processingCode,
          agency: result.agency,
        },
      };
    case 'REPLAYED':
      // The original answer, repeated verbatim — same 201, same body — so a
      // retrying client needs no new code. Only the header distinguishes it.
      return {
        status: 201,
        headers: { [IDEMPOTENCY_REPLAYED_HEADER]: 'true' },
        body: {
          status: 'SUBMITTED',
          applicationId: result.applicationId,
          processingCode: result.processingCode,
          agency: result.agency,
        },
      };
    case 'ALREADY_APPLIED':
      // The identifiers are KEPT: this is the citizen's own live application
      // for the same campaign, and the answer is useless without them.
      return {
        status: 409,
        body: {
          status: 'ALREADY_APPLIED',
          applicationId: result.applicationId,
          processingCode: result.processingCode,
          agency: result.agency,
        },
      };
    case 'KEY_REUSED':
      // Deliberately carries NO identifiers (ADR-027): the key belongs to a
      // different submission and echoing that submission's ids would leak
      // across requests.
      return { status: 409, body: { status: 'KEY_REUSED', reason: result.reason } };
    case 'APPLICANT_NOT_FOUND':
      return { status: 404, body: { status: 'APPLICANT_NOT_FOUND' } };
    case 'IDENTITY_NOT_VERIFIED':
      return { status: 409, body: { status: 'IDENTITY_NOT_VERIFIED' } };
    case 'INVALID_ACADEMIC_INPUT':
      return { status: 422, body: { status: 'INVALID_ACADEMIC_INPUT', reason: result.reason } };
    case 'NO_OPEN_CAMPAIGN':
      return { status: 409, body: { status: 'NO_OPEN_CAMPAIGN', agency: result.agency } };
    case 'DEPENDENCY_UNAVAILABLE':
      return {
        status: 502,
        body: { status: 'DEPENDENCY_UNAVAILABLE', reason: 'A dependent service is unavailable.' },
      };
    case 'UNEXPECTED_UPSTREAM_RESPONSE':
      // The raw upstream body is never echoed — an unexpected shape is a
      // wiring fault, and its content is not ours to relay.
      return {
        status: 502,
        body: { status: 'UPSTREAM_CONTRACT_MISMATCH', reason: 'A dependent service misbehaved.' },
      };
    default:
      return assertNever(result);
  }
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
