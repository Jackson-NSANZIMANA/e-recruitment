// ══════════════════════════════════════════════════════════════════
// identity-service — HTTP ingress adapter for right-to-erasure (ADR-015)
//
// POST /v1/identities/erasure — officer-only (an accountable human;
// withAuth → 401 unauthenticated, 403 for system/applicant kinds).
// The body carries only the opaque applicant UUID; raw NIDs are never
// accepted here (resolving a NID to an applicant is the verify road).
// Responses carry outcome codes and agency labels — no PII, no hashes.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import { IdentityPersistenceError } from '../../domain/identity.errors.js';
import type { EraseIdentityService } from '../../application/erase-identity.service.js';
import type { EraseIdentityOutcome } from '../../ports/erasure-repository.js';

export const ERASURE_PATH = '/v1/identities/erasure';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ErasureRequestBody {
  readonly applicantId?: unknown;
}

export function erasureRoute(service: EraseIdentityService, verify: AuthVerifier): Route {
  return {
    method: 'POST',
    path: ERASURE_PATH,
    handler: withAuth(verify, { kind: ['officer'] }, async (ctx, principal): Promise<HttpResult> => {
      const body = await ctx.json<ErasureRequestBody>();
      const applicantId = body.applicantId;
      if (typeof applicantId !== 'string' || !UUID_RE.test(applicantId)) {
        throw new HttpError(400, 'INVALID_APPLICANT_ID', 'Field "applicantId" must be a UUID.');
      }
      if (principal.kind !== 'officer') {
        // withAuth already enforced this; narrow for the type system.
        throw new HttpError(403, 'FORBIDDEN', 'Erasure requires an officer principal.');
      }

      let outcome: EraseIdentityOutcome;
      try {
        outcome = await service.erase(
          { applicantId, context: { correlationId: ctx.correlationId, causationId: ctx.correlationId } },
          principal,
        );
      } catch (err) {
        if (err instanceof IdentityPersistenceError) {
          throw new HttpError(500, 'IDENTITY_PERSISTENCE_ERROR', 'Could not execute the erasure.', { cause: err });
        }
        throw err;
      }

      return mapOutcome(outcome);
    }),
  };
}

/** Outcomes → HTTP. Refusals are 409: truthful conflict with lawful state. */
function mapOutcome(outcome: EraseIdentityOutcome): HttpResult {
  switch (outcome.kind) {
    case 'ERASED':
      return { status: 200, body: { status: 'ERASED' } };
    case 'ALREADY_ERASED':
      // Idempotent success — the demanded end-state already holds.
      return { status: 200, body: { status: 'ALREADY_ERASED' } };
    case 'REFUSED_ACTIVE_APPLICATION':
      return {
        status: 409,
        body: {
          status: 'REFUSED_ACTIVE_APPLICATION',
          agency: outcome.agency,
          currentStatus: outcome.status,
        },
      };
    case 'REFUSED_ACCEPT_LOCKED':
      return {
        status: 409,
        body: { status: 'REFUSED_ACCEPT_LOCKED', lockedByAgency: outcome.lockedByAgency },
      };
    case 'NOT_FOUND':
      return { status: 404, body: { status: 'NOT_FOUND' } };
    default:
      return assertNever(outcome);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled erasure outcome: ${JSON.stringify(value)}`);
}
