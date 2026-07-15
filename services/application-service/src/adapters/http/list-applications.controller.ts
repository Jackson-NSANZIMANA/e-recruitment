// ══════════════════════════════════════════════════════════════════
// application-service — HTTP ingress adapter for listing applications
//
// GET /v1/applications — an OFFICER-authenticated read. The route is wrapped
// in withAuth({kind:'officer'}), so the handler only runs for a verified
// officer principal (401 when unauthenticated, 403 for a system token). The
// verified Principal is passed straight into the use case, which scopes the
// read to that officer's agency and runs it under the officer DB role.
//
// Shares the path '/v1/applications' with the POST submit route; shared-http
// keys its route table by (path → method → handler), so GET and POST coexist.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import { ApplicationReadError } from '../../domain/application.errors.js';
import type {
  AmberQueueOutcome,
  ListApplicationsOutcome,
  ListApplicationsService,
} from '../../application/list-applications.service.js';

export const LIST_APPLICATIONS_PATH = '/v1/applications';
export const AMBER_QUEUE_PATH = '/v1/applications/amber-queue';

/** Build the `GET /v1/applications` officer route bound to the use case. */
export function listApplicationsRoute(
  service: ListApplicationsService,
  verify: AuthVerifier,
): Route {
  return {
    method: 'GET',
    path: LIST_APPLICATIONS_PATH,
    handler: withAuth(verify, { kind: 'officer' }, async (_ctx, principal): Promise<HttpResult> => {
      let outcome: ListApplicationsOutcome;
      try {
        outcome = await service.list({ actor: principal });
      } catch (err) {
        throw mapDomainError(err);
      }
      return mapOutcome(outcome);
    }),
  };
}

/**
 * Build the `GET /v1/applications/amber-queue` officer route — the review
 * queue of amber document holds + late-disqualification adjudication holds
 * for the officer's OWN agency (ADR-011). Non-PII: processing codes and
 * forensic signals only.
 */
export function amberQueueRoute(service: ListApplicationsService, verify: AuthVerifier): Route {
  return {
    method: 'GET',
    path: AMBER_QUEUE_PATH,
    handler: withAuth(verify, { kind: 'officer' }, async (_ctx, principal): Promise<HttpResult> => {
      let outcome: AmberQueueOutcome;
      try {
        outcome = await service.amberQueue({ actor: principal });
      } catch (err) {
        throw mapDomainError(err);
      }
      switch (outcome.kind) {
        case 'OK':
          return { status: 200, body: { agency: outcome.agency, queue: outcome.queue } };
        case 'FORBIDDEN':
          return { status: 403, body: { error: 'FORBIDDEN' } };
        default:
          return assertNever(outcome);
      }
    }),
  };
}

/** Business outcomes → HTTP status. Only non-PII fields are exposed. */
function mapOutcome(outcome: ListApplicationsOutcome): HttpResult {
  switch (outcome.kind) {
    case 'OK':
      return {
        status: 200,
        body: { agency: outcome.agency, applications: outcome.applications },
      };
    case 'FORBIDDEN':
      return { status: 403, body: { error: 'FORBIDDEN' } };
    default:
      return assertNever(outcome);
  }
}

/** Infrastructure faults → HTTP status. Messages are generic; no internals. */
function mapDomainError(err: unknown): HttpError {
  if (err instanceof ApplicationReadError) {
    return new HttpError(500, 'APPLICATION_READ_ERROR', 'Could not list applications.', { cause: err });
  }
  if (err instanceof HttpError) return err;
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled list-applications outcome: ${JSON.stringify(value)}`);
}
