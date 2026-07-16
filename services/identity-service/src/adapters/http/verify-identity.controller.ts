// ══════════════════════════════════════════════════════════════════
// identity-service — HTTP ingress adapter for identity verification
//
// Translates an inbound HTTP request into a VerifyIdentityCommand and the
// use-case outcome into an HTTP result. This is the ONLY place that knows
// about HTTP; the application/domain layers stay transport-agnostic.
//
// Two rules this adapter enforces at the edge:
//   1. The raw National ID is request-only — it never appears in a
//      response body (nor does the internal nationalIdHash, an internal
//      cross-service key). The edge gets only the opaque applicant UUID.
//   2. Business outcomes map to status codes; infrastructure faults map to
//      5xx with no internal detail leaked.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import { APPLICATION_CHANNELS, type ApplicationChannel } from '@usrp/shared-types';
import {
  IdentityPersistenceError,
  InvalidNationalIdError,
  NidaUnavailableError,
} from '../../domain/identity.errors.js';
import type {
  VerifyIdentityOutcome,
  VerifyIdentityService,
} from '../../application/verify-identity.service.js';

export const VERIFY_IDENTITY_PATH = '/v1/identities/verify';

const CHANNELS: ReadonlySet<string> = new Set(APPLICATION_CHANNELS);

/** Wire shape of the request body — every field validated before use. */
interface VerifyRequestBody {
  readonly nationalId?: unknown;
  readonly channel?: unknown;
}

/**
 * Build the `POST /v1/identities/verify` route bound to the use case. The
 * front door serves two authenticated callers (withAuth → 401 unauthenticated,
 * 403 for any other principal kind):
 *   • SYSTEM — the service-internal path (pre-registered digital flow);
 *   • OFFICER — the walk-in lane's on-site NIDA lookup (ADR-012): a field
 *     officer at the exam venue establishes a walk-in candidate's identity
 *     with the tablet online. Same two-hash contract, same PII handling —
 *     the caller kind changes nothing below the edge.
 * Real applicant-facing auth is a separate, later slice.
 */
export function verifyIdentityRoute(service: VerifyIdentityService, verify: AuthVerifier): Route {
  return {
    method: 'POST',
    path: VERIFY_IDENTITY_PATH,
    handler: withAuth(verify, { kind: ['system', 'officer'] }, async (ctx, _principal): Promise<HttpResult> => {
      const body = await ctx.json<VerifyRequestBody>();

      const rawNationalId = body.nationalId;
      if (typeof rawNationalId !== 'string' || rawNationalId.trim().length === 0) {
        throw new HttpError(400, 'MISSING_NATIONAL_ID', 'Field "nationalId" is required.');
      }
      const channel = body.channel;
      if (typeof channel !== 'string' || !CHANNELS.has(channel)) {
        throw new HttpError(
          400,
          'INVALID_CHANNEL',
          `Field "channel" must be one of: ${[...CHANNELS].join(', ')}.`,
        );
      }

      let outcome: VerifyIdentityOutcome;
      try {
        outcome = await service.verify({
          rawNationalId,
          registrationChannel: channel as ApplicationChannel,
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

/** Business outcomes → HTTP status. Only the opaque applicantId is exposed. */
function mapOutcome(outcome: VerifyIdentityOutcome): HttpResult {
  switch (outcome.kind) {
    case 'CREATED':
      return { status: 201, body: { status: 'CREATED', applicantId: outcome.applicantId } };
    case 'ALREADY_EXISTS':
      return { status: 200, body: { status: 'ALREADY_EXISTS', applicantId: outcome.applicantId } };
    case 'NOT_FOUND_IN_NIDA':
      return { status: 404, body: { status: 'NOT_FOUND_IN_NIDA' } };
    case 'NOT_A_CITIZEN':
      return { status: 422, body: { status: 'NOT_A_CITIZEN' } };
    default:
      return assertNever(outcome);
  }
}

/** Infrastructure faults → HTTP status. Messages are generic; no NID/PII. */
function mapDomainError(err: unknown): HttpError {
  if (err instanceof InvalidNationalIdError) {
    return new HttpError(400, 'INVALID_NATIONAL_ID', 'The national ID is malformed.');
  }
  if (err instanceof NidaUnavailableError) {
    return new HttpError(503, 'NIDA_UNAVAILABLE', 'The identity registry is temporarily unavailable.');
  }
  if (err instanceof IdentityPersistenceError) {
    return new HttpError(500, 'IDENTITY_PERSISTENCE_ERROR', 'Could not persist the identity.', { cause: err });
  }
  if (err instanceof HttpError) return err;
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled verify-identity outcome: ${JSON.stringify(value)}`);
}
