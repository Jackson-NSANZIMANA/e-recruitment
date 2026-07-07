// ══════════════════════════════════════════════════════════════════
// eligibility-service — HTTP ingress adapter
//
// Translates an inbound HTTP request into an EvaluateAgeEligibilityCommand
// and the use-case outcome into an HTTP result. The only HTTP-aware layer.
// The applicant's date of birth is NEVER echoed — only the derived age and
// verdict are returned.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import type { ApplicationCategory } from '@usrp/shared-types';
import { ALL_CATEGORIES } from '../../domain/category-agency.js';
import { EligibilityReadError } from '../../domain/eligibility.errors.js';
import type {
  EvaluateAgeEligibilityOutcome,
  EvaluateAgeEligibilityService,
} from '../../application/evaluate-age-eligibility.service.js';

export const AGE_CHECK_PATH = '/v1/eligibility/age-check';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AgeCheckBody {
  readonly applicantId?: unknown;
  readonly category?: unknown;
}

/** Build the `POST /v1/eligibility/age-check` route bound to the use case. */
export function ageEligibilityRoute(service: EvaluateAgeEligibilityService): Route {
  return {
    method: 'POST',
    path: AGE_CHECK_PATH,
    handler: async (ctx): Promise<HttpResult> => {
      const body = await ctx.json<AgeCheckBody>();

      const applicantId = body.applicantId;
      if (typeof applicantId !== 'string' || !UUID_PATTERN.test(applicantId)) {
        throw new HttpError(400, 'INVALID_APPLICANT_ID', 'Field "applicantId" must be a UUID.');
      }
      const category = body.category;
      if (typeof category !== 'string' || !ALL_CATEGORIES.has(category)) {
        throw new HttpError(400, 'INVALID_CATEGORY', 'Field "category" must be a known application category.');
      }

      let outcome: EvaluateAgeEligibilityOutcome;
      try {
        outcome = await service.evaluate({
          applicantId,
          category: category as ApplicationCategory,
          context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
        });
      } catch (err) {
        throw mapError(err);
      }

      return mapOutcome(outcome);
    },
  };
}

function mapOutcome(outcome: EvaluateAgeEligibilityOutcome): HttpResult {
  switch (outcome.kind) {
    case 'EVALUATED':
      // Expose only the derived age + verdict — never the raw date of birth.
      return {
        status: 200,
        body: {
          status: 'EVALUATED',
          eligible: outcome.result.eligible,
          category: outcome.category,
          agency: outcome.agency,
          ageAtEvaluation: outcome.result.ageAtEvaluation,
          appliedMaxAge: outcome.result.appliedMaxAge,
          reason: outcome.result.reason,
        },
      };
    case 'APPLICANT_NOT_FOUND':
      return { status: 404, body: { status: 'APPLICANT_NOT_FOUND' } };
    case 'IDENTITY_NOT_VERIFIED':
      return { status: 409, body: { status: 'IDENTITY_NOT_VERIFIED', identityStatus: outcome.identityStatus } };
    default:
      return assertNever(outcome);
  }
}

function mapError(err: unknown): HttpError {
  if (err instanceof EligibilityReadError) {
    return new HttpError(503, 'ELIGIBILITY_STORE_UNAVAILABLE', 'The identity store is temporarily unavailable.', { cause: err });
  }
  if (err instanceof HttpError) return err;
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled eligibility outcome: ${JSON.stringify(value)}`);
}
