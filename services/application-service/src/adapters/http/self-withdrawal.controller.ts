// ══════════════════════════════════════════════════════════════════
// application-service — HTTP ingress for voluntary self-withdrawal (ADR-020)
//
// POST /v1/applications/withdraw-own — a SYSTEM-token write, the mirror of
// the by-applicant read (ADR-018): the caller is the portal backend
// (identity-service), which authenticated the citizen's session and acts
// on their behalf. An officer token is refused (403) — this door carries
// the citizen's OWN authority, not an officer's, and must never become an
// unaudited officer withdrawal path.
//
// Slice-4 route convention: exact-match path, ids in the body. Responses
// carry outcome codes and agency labels only — no PII.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import { ApplicationPersistenceError } from '../../domain/application.errors.js';
import type {
  SelfWithdrawalOutcome,
  SelfWithdrawalService,
} from '../../application/self-withdrawal.service.js';

export const WITHDRAW_OWN_PATH = '/v1/applications/withdraw-own';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WithdrawOwnBody {
  readonly applicantId?: unknown;
  readonly applicationId?: unknown;
}

export function withdrawOwnRoute(service: SelfWithdrawalService, verify: AuthVerifier): Route {
  return {
    method: 'POST',
    path: WITHDRAW_OWN_PATH,
    handler: withAuth(verify, { kind: 'system' }, async (ctx, principal): Promise<HttpResult> => {
      const body = await ctx.json<WithdrawOwnBody>();
      const applicantId = requireUuid(body.applicantId, 'applicantId');
      const applicationId = requireUuid(body.applicationId, 'applicationId');

      let outcome: SelfWithdrawalOutcome;
      try {
        outcome = await service.withdrawOwn({
          actor: principal,
          applicantId,
          applicationId,
          context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
        });
      } catch (err) {
        throw mapDomainError(err);
      }
      return mapOutcome(outcome);
    }),
  };
}

function mapOutcome(outcome: SelfWithdrawalOutcome): HttpResult {
  switch (outcome.kind) {
    case 'WITHDRAWN':
      return {
        status: 200,
        body: { status: 'WITHDRAWN', agency: outcome.agency, fromStatus: outcome.fromStatus },
      };
    case 'NO_CHANGE':
      // Idempotent success — the demanded end-state already holds.
      return { status: 200, body: { status: 'NO_CHANGE', agency: outcome.agency } };
    case 'NOT_APPLICABLE':
      return {
        status: 409,
        body: { status: 'NOT_APPLICABLE', agency: outcome.agency, currentStatus: outcome.status },
      };
    case 'NOT_FOUND':
      return { status: 404, body: { status: 'NOT_FOUND' } };
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
  if (err instanceof ApplicationPersistenceError) {
    throw new HttpError(500, 'APPLICATION_PERSISTENCE_ERROR', 'Could not withdraw the application.', { cause: err });
  }
  if (err instanceof HttpError) return err;
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled withdraw-own outcome: ${JSON.stringify(value)}`);
}
