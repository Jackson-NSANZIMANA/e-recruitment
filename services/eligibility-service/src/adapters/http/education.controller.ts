// ══════════════════════════════════════════════════════════════════
// eligibility-service — Education (NESA) HTTP ingress adapter
//
// Translates an inbound HTTP request into a VerifyNesaEducationCommand and
// the use-case outcome into an HTTP result. The only HTTP-aware layer for
// the education gate. The candidate's school and raw index are NEVER
// echoed — only the derived academic verdict is returned.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import type { ApplicationCategory } from '@usrp/shared-types';
import { ALL_CATEGORIES } from '../../domain/category-agency.js';
import { EligibilityReadError } from '../../domain/eligibility.errors.js';
import { NesaUnavailableError } from '../../domain/nesa.types.js';
import type {
  VerifyNesaEducationOutcome,
  VerifyNesaEducationService,
} from '../../application/verify-nesa-education.service.js';

export const EDUCATION_CHECK_PATH = '/v1/eligibility/education-check';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// NESA index numbers are short public identifiers (e.g. "RW2024/1001").
const NESA_INDEX_PATTERN = /^[A-Za-z0-9/-]{4,32}$/;

interface EducationCheckBody {
  readonly applicantId?: unknown;
  readonly applicationId?: unknown;
  readonly category?: unknown;
  readonly nesaIndexNumber?: unknown;
}

/**
 * Build the `POST /v1/eligibility/education-check` route bound to the use case.
 * Service-internal: requires a valid SYSTEM bearer token (401/403 via withAuth).
 */
export function educationCheckRoute(service: VerifyNesaEducationService, verify: AuthVerifier): Route {
  return {
    method: 'POST',
    path: EDUCATION_CHECK_PATH,
    handler: withAuth(verify, { kind: 'system' }, async (ctx, _principal): Promise<HttpResult> => {
      const body = await ctx.json<EducationCheckBody>();

      const applicantId = body.applicantId;
      if (typeof applicantId !== 'string' || !UUID_PATTERN.test(applicantId)) {
        throw new HttpError(400, 'INVALID_APPLICANT_ID', 'Field "applicantId" must be a UUID.');
      }
      const applicationId = body.applicationId;
      if (typeof applicationId !== 'string' || !UUID_PATTERN.test(applicationId)) {
        throw new HttpError(400, 'INVALID_APPLICATION_ID', 'Field "applicationId" must be a UUID.');
      }
      const category = body.category;
      if (typeof category !== 'string' || !ALL_CATEGORIES.has(category)) {
        throw new HttpError(400, 'INVALID_CATEGORY', 'Field "category" must be a known application category.');
      }
      const nesaIndexNumber = body.nesaIndexNumber;
      if (typeof nesaIndexNumber !== 'string' || !NESA_INDEX_PATTERN.test(nesaIndexNumber)) {
        throw new HttpError(400, 'INVALID_NESA_INDEX', 'Field "nesaIndexNumber" must be a valid examination index.');
      }

      let outcome: VerifyNesaEducationOutcome;
      try {
        outcome = await service.verify({
          applicantId,
          applicationId,
          category: category as ApplicationCategory,
          nesaIndexNumber,
          context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
        });
      } catch (err) {
        throw mapError(err);
      }

      return mapOutcome(outcome);
    }),
  };
}

function mapOutcome(outcome: VerifyNesaEducationOutcome): HttpResult {
  switch (outcome.kind) {
    case 'EVALUATED':
      // Expose only the derived academic verdict — never the school or raw index.
      return {
        status: 200,
        body: {
          status: 'EVALUATED',
          academicStatus: outcome.academicStatus,
          eligible: outcome.education.meetsRequirement,
          category: outcome.category,
          agency: outcome.agency,
          requiredMinLevel: outcome.education.requiredMinLevel,
          evaluatedLevel: outcome.education.evaluatedLevel,
          reason: outcome.education.reason,
        },
      };
    case 'APPLICANT_NOT_FOUND':
      return { status: 404, body: { status: 'APPLICANT_NOT_FOUND' } };
    case 'IDENTITY_NOT_VERIFIED':
      return { status: 409, body: { status: 'IDENTITY_NOT_VERIFIED', identityStatus: outcome.identityStatus } };
    case 'NESA_NOT_APPLICABLE':
      return {
        status: 409,
        body: { status: 'NESA_NOT_APPLICABLE', detail: 'This category requires HEC degree verification, not NESA.' },
      };
    case 'NESA_RECORD_NOT_FOUND':
      return { status: 422, body: { status: 'NESA_RECORD_NOT_FOUND' } };
    default:
      return assertNever(outcome);
  }
}

function mapError(err: unknown): HttpError {
  if (err instanceof NesaUnavailableError) {
    return new HttpError(503, 'NESA_UNAVAILABLE', 'The NESA registry is temporarily unavailable.', { cause: err });
  }
  if (err instanceof EligibilityReadError) {
    return new HttpError(503, 'ELIGIBILITY_STORE_UNAVAILABLE', 'The identity store is temporarily unavailable.', { cause: err });
  }
  if (err instanceof HttpError) return err;
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled education outcome: ${JSON.stringify(value)}`);
}
