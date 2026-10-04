// ══════════════════════════════════════════════════════════════════
// application-service — HTTP ingress adapter for submitting an application
//
// Translates an inbound HTTP request into a SubmitApplicationCommand and
// the use-case outcome into an HTTP result. This is the ONLY place that
// knows about HTTP; the application/domain layers stay transport-agnostic.
//
// Rules enforced at this edge:
//   1. Every field is validated before use — applicantId, category (must
//      be a real category), and channel (must be a real channel). Malformed
//      input is a 400; it never reaches the use case. This also protects
//      agencyForCategory, which throws on an unknown category.
//   2. Business outcomes map to status codes; infrastructure faults map to
//      5xx with no internal detail leaked. The applicant is referenced only
//      by opaque id — no raw National ID is ever accepted or returned here.
//   3. IDEMPOTENCY (ADR-027). An optional `Idempotency-Key` request header
//      carries the caller's retry identity. It must be a UUID — a 400 here,
//      because a client that cannot produce a stable key is better told so
//      than silently given at-least-once filing. Re-sending the same key
//      with the same body replays the first response and sets
//      `Idempotency-Replayed: true`; re-sending it with a different body is
//      409 KEY_REUSED.
//
// WHY A REPLAY KEEPS ITS 201. The replayed response is byte-for-byte the
// original answer, including its status, so a client that only reads the
// status code behaves identically whether or not its first attempt survived
// — which is the entire point of a retry. The header is how a client that
// DOES care can tell the two apart; it is exposed to browsers through the
// edge tier rather than inferred from the status.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import {
  ALL_CATEGORIES,
  APPLICATION_CHANNELS,
  type ApplicationCategory,
  type ApplicationChannel,
} from '@usrp/shared-types';
import {
  ApplicationPersistenceError,
  ApplicationReadError,
} from '../../domain/application.errors.js';
import type {
  SubmitApplicationOutcome,
  SubmitApplicationService,
} from '../../application/submit-application.service.js';

export const SUBMIT_APPLICATION_PATH = '/v1/applications';

/** Request header carrying the caller's retry identity (ADR-027). */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Response header set only when a stored result was replayed, never filed. */
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

const CHANNELS: ReadonlySet<string> = new Set(APPLICATION_CHANNELS);
// The opaque applicant handle is a UUID. Validating its SHAPE here keeps a
// malformed id from reaching the uuid-typed column, where Postgres would
// raise a syntax error that surfaces as a 5xx — a client error dressed as
// a server fault. Shape only; existence is the use case's APPLICANT_NOT_FOUND.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Wire shape of the request body — every field validated before use. */
interface SubmitRequestBody {
  readonly applicantId?: unknown;
  readonly category?: unknown;
  readonly channel?: unknown;
  readonly nesaIndexNumber?: unknown;
  readonly hecRegistrationNumber?: unknown;
}

/**
 * Build the `POST /v1/applications` route bound to the use case. The front
 * door is now service-internal: it requires a valid SYSTEM bearer token
 * (withAuth → 401 unauthenticated, 403 for a non-system principal). Real
 * applicant-facing auth is a separate, later slice.
 */
export function submitApplicationRoute(
  service: SubmitApplicationService,
  verify: AuthVerifier,
): Route {
  return {
    method: 'POST',
    path: SUBMIT_APPLICATION_PATH,
    handler: withAuth(verify, { kind: 'system' }, async (ctx, _principal): Promise<HttpResult> => {
      const body = await ctx.json<SubmitRequestBody>();

      const applicantId = body.applicantId;
      if (typeof applicantId !== 'string' || applicantId.trim().length === 0) {
        throw new HttpError(400, 'MISSING_APPLICANT_ID', 'Field "applicantId" is required.');
      }
      const applicantIdTrimmed = applicantId.trim();
      if (!UUID_RE.test(applicantIdTrimmed)) {
        throw new HttpError(400, 'INVALID_APPLICANT_ID', 'Field "applicantId" must be a UUID.');
      }
      const category = body.category;
      if (typeof category !== 'string' || !ALL_CATEGORIES.has(category)) {
        throw new HttpError(400, 'INVALID_CATEGORY', 'Field "category" must be a valid application category.');
      }
      const channel = body.channel;
      if (typeof channel !== 'string' || !CHANNELS.has(channel)) {
        throw new HttpError(
          400,
          'INVALID_CHANNEL',
          `Field "channel" must be one of: ${[...CHANNELS].join(', ')}.`,
        );
      }
      // Academic inputs are optional at the wire (which one is required is a
      // domain rule, keyed off category) but, if present, must be strings.
      const nesaIndexNumber = optionalString(body.nesaIndexNumber, 'nesaIndexNumber');
      const hecRegistrationNumber = optionalString(body.hecRegistrationNumber, 'hecRegistrationNumber');
      const idempotencyKey = readIdempotencyKey(ctx.headers[IDEMPOTENCY_KEY_HEADER]);

      let outcome: SubmitApplicationOutcome;
      try {
        outcome = await service.submit({
          applicantId: applicantIdTrimmed,
          category: category as ApplicationCategory,
          channel: channel as ApplicationChannel,
          nesaIndexNumber,
          hecRegistrationNumber,
          ...(idempotencyKey === null ? {} : { idempotencyKey }),
          // Seed the event trace from the inbound HTTP correlation id.
          context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
        });
      } catch (err) {
        throw mapDomainError(err);
      }

      return mapOutcome(outcome);
    }),
  };
}

/**
 * Validate the optional `Idempotency-Key` header.
 *
 * A repeated header arrives as an array — rejected rather than resolved by
 * picking one, because the two values would denote two different requests and
 * any choice we made would be a guess about which retry the client meant.
 */
function readIdempotencyKey(raw: string | readonly string[] | undefined): string | null {
  if (raw === undefined) return null;
  if (Array.isArray(raw)) {
    throw new HttpError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Header "Idempotency-Key" must appear at most once.',
    );
  }
  const value = String(raw).trim();
  if (value.length === 0) return null;
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Header "Idempotency-Key" must be a UUID.');
  }
  return value;
}

/** Business outcomes → HTTP status. Only non-PII identifiers are exposed. */
function mapOutcome(outcome: SubmitApplicationOutcome): HttpResult {
  switch (outcome.kind) {
    case 'SUBMITTED':
      return {
        status: 201,
        body: {
          status: 'SUBMITTED',
          applicationId: outcome.applicationId,
          processingCode: outcome.processingCode,
          agency: outcome.agency,
        },
      };
    case 'REPLAYED':
      // The original answer, repeated verbatim — same 201, same body. Only
      // the header distinguishes it, so a retrying client needs no new code.
      return {
        status: 201,
        headers: { [IDEMPOTENCY_REPLAYED_HEADER]: 'true' },
        body: {
          status: 'SUBMITTED',
          applicationId: outcome.applicationId,
          processingCode: outcome.processingCode,
          agency: outcome.agency,
        },
      };
    case 'KEY_REUSED':
      // Deliberately carries NO identifiers: the key belongs to a different
      // submission, and echoing that submission's ids to a caller who asked
      // about another one would leak across requests.
      return {
        status: 409,
        body: {
          status: 'KEY_REUSED',
          reason: 'This Idempotency-Key was already used for a different submission.',
        },
      };
    case 'ALREADY_APPLIED':
      return {
        status: 409,
        body: {
          status: 'ALREADY_APPLIED',
          applicationId: outcome.applicationId,
          processingCode: outcome.processingCode,
          agency: outcome.agency,
        },
      };
    case 'APPLICANT_NOT_FOUND':
      return { status: 404, body: { status: 'APPLICANT_NOT_FOUND' } };
    case 'IDENTITY_NOT_VERIFIED':
      return { status: 409, body: { status: 'IDENTITY_NOT_VERIFIED' } };
    case 'INVALID_ACADEMIC_INPUT':
      return { status: 422, body: { status: 'INVALID_ACADEMIC_INPUT', reason: outcome.reason } };
    case 'NO_OPEN_CAMPAIGN':
      return { status: 409, body: { status: 'NO_OPEN_CAMPAIGN', agency: outcome.agency } };
    default:
      return assertNever(outcome);
  }
}

/** Infrastructure faults → HTTP status. Messages are generic; no internals. */
function mapDomainError(err: unknown): HttpError {
  if (err instanceof ApplicationReadError) {
    return new HttpError(500, 'APPLICATION_READ_ERROR', 'Could not read applicant or campaign state.', { cause: err });
  }
  if (err instanceof ApplicationPersistenceError) {
    return new HttpError(500, 'APPLICATION_PERSISTENCE_ERROR', 'Could not file the application.', { cause: err });
  }
  if (err instanceof HttpError) return err;
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
}

/** A present body field must be a string; absent → null. Never coerces. */
function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'INVALID_FIELD', `Field "${field}" must be a string when present.`);
  }
  return value;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled submit-application outcome: ${JSON.stringify(value)}`);
}
