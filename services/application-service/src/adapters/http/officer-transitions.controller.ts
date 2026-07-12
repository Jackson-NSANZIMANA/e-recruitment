// ══════════════════════════════════════════════════════════════════
// application-service — HTTP ingress for officer lifecycle transitions
//
// Three OFFICER-authenticated write endpoints that complete the green digital
// lane. shared-http routes by EXACT path (no path params), so applicationId
// travels in the BODY; each path is distinct from POST/GET /v1/applications.
//
//   POST /v1/applications/medical-review  {applicationId, fitnessStatus}
//   POST /v1/applications/final-decision  {applicationId, decision, notes?}
//   POST /v1/applications/accept          {applicationId}
//
// All wrapped in withAuth({kind:'officer'}) → 401 unauthenticated, 403 for a
// system token. The verified Principal is handed to the use case, which scopes
// the write to the officer's agency and runs it under the officer DB role.
// Only non-PII fields (ids, statuses) cross this boundary.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import { ApplicationPersistenceError } from '../../domain/application.errors.js';
import type {
  AcceptCommand,
  FinalDecisionCommand,
  MedicalReviewCommand,
  OfficerCommandOutcome,
  OfficerTransitionsService,
} from '../../application/officer-transitions.service.js';

export const MEDICAL_REVIEW_PATH = '/v1/applications/medical-review';
export const FINAL_DECISION_PATH = '/v1/applications/final-decision';
export const ACCEPT_PATH = '/v1/applications/accept';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FITNESS = new Set(['FIT', 'UNFIT']);
const DECISIONS = new Set(['SHORTLIST', 'REJECT']);
const MAX_NOTES = 1000; // final_decision_notes is varchar(1000)

interface TransitionBody {
  readonly applicationId?: unknown;
  readonly fitnessStatus?: unknown;
  readonly decision?: unknown;
  readonly notes?: unknown;
}

/** The three officer-transition routes, bound to the use case + auth verifier. */
export function officerTransitionRoutes(
  service: OfficerTransitionsService,
  verify: AuthVerifier,
): Route[] {
  return [
    {
      method: 'POST',
      path: MEDICAL_REVIEW_PATH,
      handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
        const body = await ctx.json<TransitionBody>();
        const applicationId = requireApplicationId(body.applicationId);
        const fitnessStatus = body.fitnessStatus;
        if (typeof fitnessStatus !== 'string' || !FITNESS.has(fitnessStatus)) {
          throw new HttpError(400, 'INVALID_FITNESS_STATUS', 'Field "fitnessStatus" must be "FIT" or "UNFIT".');
        }
        const command: MedicalReviewCommand = {
          actor: principal,
          applicationId,
          fitnessStatus: fitnessStatus as 'FIT' | 'UNFIT',
          context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
        };
        return runTransition(() => service.medicalReview(command));
      }),
    },
    {
      method: 'POST',
      path: FINAL_DECISION_PATH,
      handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
        const body = await ctx.json<TransitionBody>();
        const applicationId = requireApplicationId(body.applicationId);
        const decision = body.decision;
        if (typeof decision !== 'string' || !DECISIONS.has(decision)) {
          throw new HttpError(400, 'INVALID_DECISION', 'Field "decision" must be "SHORTLIST" or "REJECT".');
        }
        const notes = requireNotes(body.notes);
        const command: FinalDecisionCommand = {
          actor: principal,
          applicationId,
          decision: decision as 'SHORTLIST' | 'REJECT',
          notes,
          context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
        };
        return runTransition(() => service.finalDecision(command));
      }),
    },
    {
      method: 'POST',
      path: ACCEPT_PATH,
      handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
        const body = await ctx.json<TransitionBody>();
        const applicationId = requireApplicationId(body.applicationId);
        const command: AcceptCommand = {
          actor: principal,
          applicationId,
          context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
        };
        return runTransition(() => service.accept(command));
      }),
    },
  ];
}

/** Validate the body's applicationId is a UUID (shape only). 400 otherwise. */
function requireApplicationId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'MISSING_APPLICATION_ID', 'Field "applicationId" is required.');
  }
  const trimmed = value.trim();
  if (!UUID_RE.test(trimmed)) {
    throw new HttpError(400, 'INVALID_APPLICATION_ID', 'Field "applicationId" must be a UUID.');
  }
  return trimmed;
}

/** Optional notes: a string within the column bound, or null when absent. */
function requireNotes(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'INVALID_NOTES', 'Field "notes" must be a string when present.');
  }
  if (value.length > MAX_NOTES) {
    throw new HttpError(400, 'INVALID_NOTES', `Field "notes" must be at most ${MAX_NOTES} characters.`);
  }
  return value;
}

/** Run a transition, mapping its outcome (or infra fault) to an HTTP result. */
async function runTransition(run: () => Promise<OfficerCommandOutcome>): Promise<HttpResult> {
  let outcome: OfficerCommandOutcome;
  try {
    outcome = await run();
  } catch (err) {
    throw mapDomainError(err);
  }
  return mapOutcome(outcome);
}

/** Business outcomes → HTTP status. Only non-PII identifiers/statuses exposed. */
function mapOutcome(outcome: OfficerCommandOutcome): HttpResult {
  switch (outcome.kind) {
    case 'APPLIED':
      return {
        status: 200,
        body: { status: 'APPLIED', fromStatus: outcome.fromStatus, toStatus: outcome.toStatus },
      };
    case 'NO_CHANGE':
      return { status: 200, body: { status: 'NO_CHANGE', currentStatus: outcome.currentStatus } };
    case 'NOT_APPLICABLE':
      return { status: 409, body: { status: 'NOT_APPLICABLE', currentStatus: outcome.currentStatus } };
    case 'NOT_FOUND':
      return { status: 404, body: { status: 'NOT_FOUND' } };
    case 'FORBIDDEN':
      return { status: 403, body: { error: 'FORBIDDEN' } };
    case 'UNSUPPORTED_AGENCY':
      // The transition is not modelled for this agency yet (e.g. medical review
      // is RDF-only pending tri-agency medical modelling). Honest 501, not a 500.
      return { status: 501, body: { status: 'UNSUPPORTED_AGENCY', agency: outcome.agency } };
    default:
      return assertNever(outcome);
  }
}

/** Infrastructure faults → HTTP status. Messages are generic; no internals. */
function mapDomainError(err: unknown): HttpError {
  if (err instanceof ApplicationPersistenceError) {
    return new HttpError(500, 'APPLICATION_PERSISTENCE_ERROR', 'Could not apply the transition.', { cause: err });
  }
  if (err instanceof HttpError) return err;
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled officer-transition outcome: ${JSON.stringify(value)}`);
}
