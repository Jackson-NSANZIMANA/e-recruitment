// ══════════════════════════════════════════════════════════════════
// eligibility-service — Degree (HEC) HTTP ingress adapter
//
// Translates an inbound HTTP request into a VerifyHecEducationCommand and
// the use-case outcome into an HTTP result. The only HTTP-aware layer for
// the degree gate. The registration number and G2G hash are NEVER echoed —
// only the derived academic verdict + degree provenance are returned.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import type { ApplicationCategory } from '@usrp/shared-types';
import { ALL_CATEGORIES } from '../../domain/category-agency.js';
import { EligibilityReadError } from '../../domain/eligibility.errors.js';
import { HecUnavailableError } from '../../domain/hec.types.js';
import type {
  VerifyHecEducationOutcome,
  VerifyHecEducationService,
} from '../../application/verify-hec-education.service.js';

export const DEGREE_CHECK_PATH = '/v1/eligibility/degree-check';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// HEC registration numbers are short institutional identifiers, e.g.
// "UR/2023/CS/001" or "IPRC/2023/ENG/078".
const HEC_REG_PATTERN = /^[A-Za-z0-9/-]{4,40}$/;

interface DegreeCheckBody {
  readonly applicantId?: unknown;
  readonly applicationId?: unknown;
  readonly category?: unknown;
  readonly hecRegistrationNumber?: unknown;
}

/** Build the `POST /v1/eligibility/degree-check` route bound to the use case. */
export function degreeCheckRoute(service: VerifyHecEducationService): Route {
  return {
    method: 'POST',
    path: DEGREE_CHECK_PATH,
    handler: async (ctx): Promise<HttpResult> => {
      const body = await ctx.json<DegreeCheckBody>();

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
      const hecRegistrationNumber = body.hecRegistrationNumber;
      if (typeof hecRegistrationNumber !== 'string' || !HEC_REG_PATTERN.test(hecRegistrationNumber)) {
        throw new HttpError(400, 'INVALID_HEC_REGISTRATION', 'Field "hecRegistrationNumber" must be a valid registration number.');
      }

      let outcome: VerifyHecEducationOutcome;
      try {
        outcome = await service.verify({
          applicantId,
          applicationId,
          category: category as ApplicationCategory,
          hecRegistrationNumber,
          context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
        });
      } catch (err) {
        throw mapError(err);
      }

      return mapOutcome(outcome);
    },
  };
}

function mapOutcome(outcome: VerifyHecEducationOutcome): HttpResult {
  switch (outcome.kind) {
    case 'EVALUATED':
      // Expose only the derived verdict + degree provenance — never the
      // registration number or the G2G subject hash.
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
          specialistField: outcome.education.specialistField,
          appliedMaxAge: outcome.education.appliedMaxAge,
          ageExceptionApplies: outcome.education.ageExceptionApplies,
          reason: outcome.education.reason,
        },
      };
    case 'APPLICANT_NOT_FOUND':
      return { status: 404, body: { status: 'APPLICANT_NOT_FOUND' } };
    case 'IDENTITY_NOT_VERIFIED':
      return { status: 409, body: { status: 'IDENTITY_NOT_VERIFIED', identityStatus: outcome.identityStatus } };
    case 'G2G_SUBJECT_UNAVAILABLE':
      return {
        status: 409,
        body: { status: 'G2G_SUBJECT_UNAVAILABLE', detail: 'Identity predates the G2G subject hash; re-verify identity.' },
      };
    case 'HEC_NOT_APPLICABLE':
      return {
        status: 409,
        body: { status: 'HEC_NOT_APPLICABLE', detail: 'This category requires NESA A-Level verification, not HEC.' },
      };
    case 'DEGREE_NOT_FOUND':
      return { status: 422, body: { status: 'DEGREE_NOT_FOUND' } };
    case 'DEGREE_HOLDER_MISMATCH':
      return { status: 422, body: { status: 'DEGREE_HOLDER_MISMATCH' } };
    default:
      return assertNever(outcome);
  }
}

function mapError(err: unknown): HttpError {
  if (err instanceof HecUnavailableError) {
    return new HttpError(503, 'HEC_UNAVAILABLE', 'The HEC registry is temporarily unavailable.', { cause: err });
  }
  if (err instanceof EligibilityReadError) {
    return new HttpError(503, 'ELIGIBILITY_STORE_UNAVAILABLE', 'The identity store is temporarily unavailable.', { cause: err });
  }
  if (err instanceof HttpError) return err;
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled degree outcome: ${JSON.stringify(value)}`);
}
