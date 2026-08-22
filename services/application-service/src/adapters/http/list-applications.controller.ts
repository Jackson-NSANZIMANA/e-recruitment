// ══════════════════════════════════════════════════════════════════
// application-service — HTTP ingress adapter for reading applications
//
// GET /v1/applications — an OFFICER-authenticated read. The route is wrapped
// in withAuth({kind:'officer'}), so the handler only runs for a verified
// officer principal (401 when unauthenticated, 403 for a system token). The
// verified Principal is passed straight into the use case, which scopes the
// read to that officer's agency and runs it under the officer DB role.
//
// Shares the path '/v1/applications' with the POST submit route; shared-http
// keys its route table by (path → method → handler), so GET and POST coexist.
//
// SINGLE-RECORD READS USE A QUERY PARAM, NOT A PATH PARAM. shared-http matches
// paths EXACTLY and has no param syntax (ADR-005, Invariant 1), so
// `/v1/applications/by-id?applicationId=` follows the same shape as the
// existing `by-applicant?applicantId=` route rather than inventing
// `/v1/applications/:id`, which this substrate cannot route. Restoring REST
// ergonomics for the browser is the edge tier's job, not the service's.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import { ApplicationReadError } from '../../domain/application.errors.js';
import type {
  AmberQueueOutcome,
  FindApplicationOutcome,
  ListApplicationsOutcome,
  ListApplicationsService,
  ListByApplicantOutcome,
  StatusHistoryOutcome,
} from '../../application/list-applications.service.js';

export const LIST_APPLICATIONS_PATH = '/v1/applications';
export const AMBER_QUEUE_PATH = '/v1/applications/amber-queue';
export const BY_APPLICANT_PATH = '/v1/applications/by-applicant';
export const BY_ID_PATH = '/v1/applications/by-id';
export const STATUS_HISTORY_PATH = '/v1/applications/status-history';

// Same shape validation as the submit route — a malformed id must be a 400,
// not a 5xx dressed up as a server fault at the uuid column.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read and shape-validate `?applicationId=` or fail with a 400. */
function requireApplicationId(query: URLSearchParams): string {
  const applicationId = query.get('applicationId')?.trim() ?? '';
  if (!UUID_RE.test(applicationId)) {
    throw new HttpError(400, 'INVALID_APPLICATION_ID', 'Query "applicationId" must be a UUID.');
  }
  return applicationId;
}

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

/**
 * Build the `GET /v1/applications/by-applicant?applicantId=…` route — the
 * cross-agency self-service read behind the applicant portal (ADR-018). It
 * requires a SYSTEM token: the caller is the portal backend
 * (identity-service), which has already authenticated the citizen's session
 * and asks on their behalf. An officer token is refused (403) — the citizen
 * door must never widen an officer's agency-scoped view.
 */
export function byApplicantRoute(service: ListApplicationsService, verify: AuthVerifier): Route {
  return {
    method: 'GET',
    path: BY_APPLICANT_PATH,
    handler: withAuth(verify, { kind: 'system' }, async (ctx, principal): Promise<HttpResult> => {
      const applicantId = ctx.query.get('applicantId')?.trim() ?? '';
      if (!UUID_RE.test(applicantId)) {
        throw new HttpError(400, 'INVALID_APPLICANT_ID', 'Query "applicantId" must be a UUID.');
      }
      let outcome: ListByApplicantOutcome;
      try {
        outcome = await service.listByApplicant({ actor: principal, applicantId });
      } catch (err) {
        throw mapDomainError(err);
      }
      switch (outcome.kind) {
        case 'OK':
          return { status: 200, body: { applications: outcome.applications } };
        case 'FORBIDDEN':
          return { status: 403, body: { error: 'FORBIDDEN' } };
        default:
          return assertNever(outcome);
      }
    }),
  };
}

/**
 * Build the `GET /v1/applications/by-id?applicationId=…` officer route — ONE
 * application from the caller's OWN agency. Nothing in the system returned a
 * single application before this; the console's detail screen had no source.
 *
 * The 404 body is deliberately BARE (`{ error: 'NOT_FOUND' }`, no detail).
 * A sibling agency's application id and a wholly nonexistent one produce the
 * SAME response, so an officer cannot walk ids to learn what another agency
 * is processing.
 */
export function byIdRoute(service: ListApplicationsService, verify: AuthVerifier): Route {
  return {
    method: 'GET',
    path: BY_ID_PATH,
    handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
      const applicationId = requireApplicationId(ctx.query);
      let outcome: FindApplicationOutcome;
      try {
        outcome = await service.findById({ actor: principal, applicationId });
      } catch (err) {
        throw mapDomainError(err);
      }
      switch (outcome.kind) {
        case 'OK':
          return {
            status: 200,
            body: { agency: outcome.agency, application: outcome.application },
          };
        case 'NOT_FOUND':
          return { status: 404, body: { error: 'NOT_FOUND' } };
        case 'FORBIDDEN':
          return { status: 403, body: { error: 'FORBIDDEN' } };
        default:
          return assertNever(outcome);
      }
    }),
  };
}

/**
 * Build the `GET /v1/applications/status-history?applicationId=…` officer
 * route — the append-only transition trail (rls/0007), oldest first, carrying
 * actor + actor kind + timestamp + note per entry.
 *
 * This route IS the Procedural Justice surface: without it, "the applicant can
 * see who decided what, when, and on what ground" is unimplementable no
 * matter how good the UI is. Same bare 404 as by-id, for the same reason.
 */
export function statusHistoryRoute(service: ListApplicationsService, verify: AuthVerifier): Route {
  return {
    method: 'GET',
    path: STATUS_HISTORY_PATH,
    handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
      const applicationId = requireApplicationId(ctx.query);
      let outcome: StatusHistoryOutcome;
      try {
        outcome = await service.statusHistory({ actor: principal, applicationId });
      } catch (err) {
        throw mapDomainError(err);
      }
      switch (outcome.kind) {
        case 'OK':
          return {
            status: 200,
            body: {
              agency: outcome.agency,
              applicationId: outcome.applicationId,
              history: outcome.history,
            },
          };
        case 'NOT_FOUND':
          return { status: 404, body: { error: 'NOT_FOUND' } };
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
