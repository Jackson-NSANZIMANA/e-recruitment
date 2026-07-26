// ══════════════════════════════════════════════════════════════════
// identity-service — HTTP ingress for erasure request intake (ADR-020)
//
// Four routes, two auth postures:
//   • me/erasure-request POST + GET — SESSION-authenticated (owner D5
//     opaque token, same discipline as the other me-routes): the data
//     subject files their demand and watches its status. Filing is
//     idempotent — a live request is returned, not duplicated.
//   • identities/erasure-requests GET + decline POST — OFFICER-
//     authenticated: the DPO queue and the accountable decline. The
//     EXECUTE decision deliberately has no route here — execution IS
//     the existing gated erasure road (ADR-015), which stamps the
//     request via the use case's intake integration.
//
// Responses are PII-free: opaque UUIDs, statuses, timestamps, grounds.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import { IdentityPersistenceError } from '../../domain/identity.errors.js';
import type { ApplicantAuthService } from '../../application/applicant-auth.service.js';
import type { ErasureRequestService } from '../../application/erasure-request.service.js';

export const ME_ERASURE_REQUEST_PATH = '/v1/applicants/me/erasure-request';
export const ERASURE_REQUESTS_QUEUE_PATH = '/v1/identities/erasure-requests';
export const ERASURE_REQUEST_DECLINE_PATH = '/v1/identities/erasure-requests/decline';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE = 200; // decision_note varchar(200)

interface DeclineBody {
  readonly requestId?: unknown;
  readonly note?: unknown;
}

export function erasureRequestRoutes(
  service: ErasureRequestService,
  auth: ApplicantAuthService,
  verify: AuthVerifier,
): Route[] {
  return [
    {
      method: 'POST',
      path: ME_ERASURE_REQUEST_PATH,
      handler: async (ctx): Promise<HttpResult> => {
        const applicantId = await authenticate(ctx.headers['authorization'], auth);
        let outcome;
        try {
          outcome = await service.file({
            applicantId,
            context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
          });
        } catch (err) {
          throw mapDomainError(err);
        }
        // 202 both ways: the demand is on record, a human decides next.
        return { status: 202, body: { status: 'PENDING', requestId: outcome.requestId } };
      },
    },
    {
      method: 'GET',
      path: ME_ERASURE_REQUEST_PATH,
      handler: async (ctx): Promise<HttpResult> => {
        const applicantId = await authenticate(ctx.headers['authorization'], auth);
        let record;
        try {
          record = await service.statusFor(applicantId);
        } catch (err) {
          throw mapDomainError(err);
        }
        if (record === null) {
          return { status: 404, body: { status: 'NONE' } };
        }
        return {
          status: 200,
          body: {
            requestId: record.requestId,
            status: record.status,
            requestedAt: record.requestedAt,
            decidedAt: record.decidedAt,
            // The ground is the citizen's to see — it answers THEIR demand.
            decisionNote: record.decisionNote,
          },
        };
      },
    },
    {
      method: 'GET',
      path: ERASURE_REQUESTS_QUEUE_PATH,
      handler: withAuth(verify, { kind: 'officer' }, async (): Promise<HttpResult> => {
        let queue;
        try {
          queue = await service.pendingQueue();
        } catch (err) {
          throw mapDomainError(err);
        }
        return {
          status: 200,
          body: {
            requests: queue.map((r) => ({
              requestId: r.requestId,
              applicantId: r.applicantId,
              requestedAt: r.requestedAt,
            })),
          },
        };
      }),
    },
    {
      method: 'POST',
      path: ERASURE_REQUEST_DECLINE_PATH,
      handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
        if (principal.kind !== 'officer') {
          // withAuth already enforced this; narrow for the type system.
          throw new HttpError(403, 'FORBIDDEN', 'Declining requires an officer principal.');
        }
        const body = await ctx.json<DeclineBody>();
        const requestId = body.requestId;
        if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) {
          throw new HttpError(400, 'INVALID_REQUEST', 'Field "requestId" must be a UUID.');
        }
        const note = body.note;
        if (typeof note !== 'string' || note.trim().length === 0 || note.length > MAX_NOTE) {
          throw new HttpError(400, 'INVALID_REQUEST', `Field "note" is required (max ${MAX_NOTE} chars).`);
        }
        let outcome;
        try {
          outcome = await service.decline(
            {
              requestId,
              note,
              context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
            },
            principal,
          );
        } catch (err) {
          throw mapDomainError(err);
        }
        switch (outcome.kind) {
          case 'DECLINED':
            return { status: 200, body: { status: 'DECLINED' } };
          case 'NOT_PENDING':
            return { status: 409, body: { status: 'NOT_PENDING', currentStatus: outcome.status } };
          case 'NOT_FOUND':
            return { status: 404, body: { status: 'NOT_FOUND' } };
          default:
            return assertNever(outcome);
        }
      }),
    },
  ];
}

/** Resolve a live session to its applicant, or one uniform 401. */
async function authenticate(
  header: string | string[] | undefined,
  auth: ApplicantAuthService,
): Promise<string> {
  const value = (Array.isArray(header) ? header[0] : header) ?? '';
  if (!value.startsWith('Bearer ') || value.length <= 7) {
    throw new HttpError(401, 'INVALID_SESSION', 'A valid session token is required.');
  }
  let applicantId: string | null;
  try {
    applicantId = await auth.authenticateSession(value.slice(7));
  } catch (err) {
    throw mapDomainError(err);
  }
  if (applicantId === null) {
    throw new HttpError(401, 'INVALID_SESSION', 'A valid session token is required.');
  }
  return applicantId;
}

function mapDomainError(err: unknown): HttpError {
  if (err instanceof IdentityPersistenceError) {
    return new HttpError(500, 'PERSISTENCE_ERROR', 'Could not complete the request.', { cause: err });
  }
  if (err instanceof HttpError) return err;
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled erasure-request outcome: ${JSON.stringify(value)}`);
}
