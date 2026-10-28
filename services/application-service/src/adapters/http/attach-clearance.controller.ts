// ══════════════════════════════════════════════════════════════════
// application-service — HTTP ingress for the citizen's clearance certificate
// number (ADR-048 §2.3)
//
// POST /v1/applications/clearance-certificate-own — a SYSTEM-token write, the
// mirror of withdraw-own: the caller is the portal backend (identity-service),
// which authenticated the citizen's session and acts on their behalf. An
// officer token is refused (403). Ids in the body; responses carry outcome
// codes and agency labels only: the number is never echoed.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import { ApplicationReadError } from '../../domain/application.errors.js';
import type { AttachClearanceCertificateService, AttachClearanceOutcome } from '../../application/attach-clearance-certificate.service.js';

export const ATTACH_CLEARANCE_OWN_PATH = '/v1/applications/clearance-certificate-own';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AttachBody {
  readonly applicantId?: unknown;
  readonly applicationId?: unknown;
  readonly clearanceCertificateNumber?: unknown;
}

export function attachClearanceOwnRoute(service: AttachClearanceCertificateService, verify: AuthVerifier): Route {
  return {
    method: 'POST',
    path: ATTACH_CLEARANCE_OWN_PATH,
    handler: withAuth(verify, { kind: 'system' }, async (ctx, principal): Promise<HttpResult> => {
      const body = await ctx.json<AttachBody>();
      const applicantId = requireUuid(body.applicantId, 'applicantId');
      const applicationId = requireUuid(body.applicationId, 'applicationId');
      if (typeof body.clearanceCertificateNumber !== 'string' || body.clearanceCertificateNumber.length === 0 || body.clearanceCertificateNumber.length > 64) {
        throw new HttpError(400, 'INVALID_REQUEST', 'Field "clearanceCertificateNumber" must be a string of 1–64 characters.');
      }
      let outcome: AttachClearanceOutcome;
      try {
        outcome = await service.attach({
          actor: principal,
          applicantId,
          applicationId,
          clearanceCertificateNumber: body.clearanceCertificateNumber,
          context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
        });
      } catch (err) {
        throw mapDomainError(err);
      }
      return mapOutcome(outcome);
    }),
  };
}

function mapOutcome(outcome: AttachClearanceOutcome): HttpResult {
  switch (outcome.kind) {
    case 'ACCEPTED':
      return { status: 202, body: { status: 'ACCEPTED', agency: outcome.agency } };
    case 'ALREADY_VERIFIED':
      return { status: 200, body: { status: 'ALREADY_VERIFIED', agency: outcome.agency } };
    case 'NOT_APPLICABLE':
      return { status: 409, body: { status: 'NOT_APPLICABLE', agency: outcome.agency, currentStatus: outcome.status } };
    case 'NOT_FOUND':
      return { status: 404, body: { status: 'NOT_FOUND' } };
    case 'INVALID_NUMBER':
      return { status: 422, body: { status: 'INVALID_NUMBER' } };
    case 'NOT_ENABLED':
      return { status: 501, body: { status: 'NOT_ENABLED' } };
    case 'FORBIDDEN':
      return { status: 403, body: { error: 'FORBIDDEN' } };
    default:
      return assertNever(outcome);
  }
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new HttpError(400, 'INVALID_REQUEST', `Field "${field}" must be a UUID.`);
  }
  return value;
}

function mapDomainError(err: unknown): HttpError {
  if (err instanceof ApplicationReadError) {
    return new HttpError(500, 'APPLICATION_READ_ERROR', 'Could not process the clearance certificate.', { cause: err });
  }
  if (err instanceof HttpError) return err;
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled attach-clearance outcome: ${JSON.stringify(value)}`);
}
