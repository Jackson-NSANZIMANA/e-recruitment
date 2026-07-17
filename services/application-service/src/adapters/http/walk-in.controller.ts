// ══════════════════════════════════════════════════════════════════
// application-service — HTTP ingress for the walk-in lane (ADR-012)
//
// Two OFFICER-authenticated endpoints for the field officer's exam-day
// tablet (shared-http routes by exact path; ids travel in the body):
//
//   POST /v1/applications/walk-in/register  {applicantId, category,
//                                            nesaIndexNumber?, hecRegistrationNumber?}
//   POST /v1/applications/walk-in/vet       {applicationId}
//
// Both wrapped in withAuth({kind:'officer'}) → 401/403. RDF-only is policy in
// the use case (clean 501 UNSUPPORTED_AGENCY for RNP/RCS officers, mirroring
// the medical-review divergence pattern). Only non-PII fields cross this
// boundary: opaque ids, category, statuses, and the minted on-site ticket.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import { ALL_CATEGORIES, type ApplicationCategory } from '@usrp/shared-types';
import { ApplicationPersistenceError, ApplicationReadError } from '../../domain/application.errors.js';
import type {
  RegisterWalkInOutcome,
  VetWalkInOutcome,
  WalkInService,
} from '../../application/walk-in.service.js';

export const WALK_IN_REGISTER_PATH = '/v1/applications/walk-in/register';
export const WALK_IN_VET_PATH = '/v1/applications/walk-in/vet';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES: ReadonlySet<string> = ALL_CATEGORIES;

interface RegisterBody {
  readonly applicantId?: unknown;
  readonly category?: unknown;
  readonly nesaIndexNumber?: unknown;
  readonly hecRegistrationNumber?: unknown;
}

interface VetBody {
  readonly applicationId?: unknown;
}

/** The two walk-in routes, bound to the use case + auth verifier. */
export function walkInRoutes(service: WalkInService, verify: AuthVerifier): Route[] {
  return [
    {
      method: 'POST',
      path: WALK_IN_REGISTER_PATH,
      handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
        const body = await ctx.json<RegisterBody>();
        const applicantId = requireUuid(body.applicantId, 'applicantId');
        const category = body.category;
        if (typeof category !== 'string' || !CATEGORIES.has(category)) {
          throw new HttpError(400, 'INVALID_CATEGORY', 'Field "category" must be a known application category.');
        }
        const nesaIndexNumber = optionalString(body.nesaIndexNumber, 'nesaIndexNumber');
        const hecRegistrationNumber = optionalString(body.hecRegistrationNumber, 'hecRegistrationNumber');

        let outcome: RegisterWalkInOutcome;
        try {
          outcome = await service.register({
            actor: principal,
            applicantId,
            category: category as ApplicationCategory,
            nesaIndexNumber,
            hecRegistrationNumber,
            context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
          });
        } catch (err) {
          throw mapDomainError(err);
        }
        return mapRegisterOutcome(outcome);
      }),
    },
    {
      method: 'POST',
      path: WALK_IN_VET_PATH,
      handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
        const body = await ctx.json<VetBody>();
        const applicationId = requireUuid(body.applicationId, 'applicationId');

        let outcome: VetWalkInOutcome;
        try {
          outcome = await service.vetOnSite({
            actor: principal,
            applicationId,
            context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
          });
        } catch (err) {
          throw mapDomainError(err);
        }
        return mapVetOutcome(outcome);
      }),
    },
  ];
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, `MISSING_${field.toUpperCase()}`, `Field "${field}" is required.`);
  }
  const trimmed = value.trim();
  if (!UUID_RE.test(trimmed)) {
    throw new HttpError(400, `INVALID_${field.toUpperCase()}`, `Field "${field}" must be a UUID.`);
  }
  return trimmed;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, `INVALID_${field.toUpperCase()}`, `Field "${field}" must be a string when present.`);
  }
  return value;
}

/** Registration outcomes → HTTP. The minted on-site ticket goes to the tablet. */
function mapRegisterOutcome(outcome: RegisterWalkInOutcome): HttpResult {
  switch (outcome.kind) {
    case 'REGISTERED':
      return {
        status: 201,
        body: {
          status: 'REGISTERED',
          applicationId: outcome.applicationId,
          processingCode: outcome.processingCode,
          qrInvitationCode: outcome.qrInvitationCode,
        },
      };
    case 'FORBIDDEN':
      return { status: 403, body: { error: 'FORBIDDEN' } };
    case 'UNSUPPORTED_AGENCY':
      // Walk-in is an RDF-only lane (rdf_ops is the only schema modelling the
      // WALK_IN_* statuses) — honest 501 for RNP/RCS, not a raw DB enum error.
      return { status: 501, body: { status: 'UNSUPPORTED_AGENCY', agency: outcome.agency } };
    case 'WRONG_AGENCY_CATEGORY':
      return {
        status: 422,
        body: { status: 'WRONG_AGENCY_CATEGORY', categoryAgency: outcome.categoryAgency },
      };
    case 'APPLICANT_NOT_FOUND':
      return { status: 404, body: { status: 'APPLICANT_NOT_FOUND' } };
    case 'IDENTITY_NOT_VERIFIED':
      return { status: 409, body: { status: 'IDENTITY_NOT_VERIFIED' } };
    case 'INVALID_ACADEMIC_INPUT':
      return { status: 422, body: { status: 'INVALID_ACADEMIC_INPUT', reason: outcome.reason } };
    case 'NO_WALK_IN_CAMPAIGN':
      return { status: 409, body: { status: 'NO_WALK_IN_CAMPAIGN', agency: outcome.agency } };
    default:
      return assertNever(outcome);
  }
}

/** On-site vetting outcomes → HTTP. AGE_PENDING is a retryable 409. */
function mapVetOutcome(outcome: VetWalkInOutcome): HttpResult {
  switch (outcome.kind) {
    case 'APPLIED':
      return {
        status: 200,
        body: {
          status: 'APPLIED',
          fromStatus: outcome.fromStatus,
          toStatus: outcome.toStatus,
          ageStatus: outcome.ageStatus,
        },
      };
    case 'AGE_PENDING':
      // The autonomous age verdict hasn't landed yet (it rides the backbone
      // off the register's APPLICANT_SUBMITTED) — the tablet retries shortly.
      return { status: 409, body: { status: 'AGE_PENDING', currentStatus: outcome.currentStatus } };
    case 'NO_CHANGE':
      return { status: 200, body: { status: 'NO_CHANGE', currentStatus: outcome.currentStatus } };
    case 'NOT_APPLICABLE':
      return { status: 409, body: { status: 'NOT_APPLICABLE', currentStatus: outcome.currentStatus } };
    case 'NOT_FOUND':
      return { status: 404, body: { status: 'NOT_FOUND' } };
    case 'FORBIDDEN':
      return { status: 403, body: { error: 'FORBIDDEN' } };
    case 'UNSUPPORTED_AGENCY':
      return { status: 501, body: { status: 'UNSUPPORTED_AGENCY', agency: outcome.agency } };
    default:
      return assertNever(outcome);
  }
}

/** Infrastructure faults → HTTP. Messages are generic; no internals leak. */
function mapDomainError(err: unknown): HttpError {
  if (err instanceof ApplicationPersistenceError) {
    return new HttpError(500, 'APPLICATION_PERSISTENCE_ERROR', 'Could not persist the walk-in registration.', { cause: err });
  }
  if (err instanceof ApplicationReadError) {
    return new HttpError(500, 'APPLICATION_READ_ERROR', 'Could not resolve the walk-in campaign.', { cause: err });
  }
  if (err instanceof HttpError) return err;
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled walk-in outcome: ${JSON.stringify(value)}`);
}
