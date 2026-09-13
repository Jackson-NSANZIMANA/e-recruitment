// ══════════════════════════════════════════════════════════════════
// edge-gateway — The FOUR transitions. Not one.
//
// There is no generic status transition and the edge does not invent one. The
// old frontend had a `PATCH /applications/{id}/status` taking a target status:
// unroutable (this substrate has no path params and no PATCH), and a broken
// authorization model even if it had routed — these four operations carry
// DIFFERENT authority, so collapsing them into one field write is not a URL
// style choice.
//
// NONE OF THEM RETURNS AN APPLICATION. The old hook was typed
// `UseMutationResult<Application>` and wrote the response into its detail
// cache, which would have poisoned the cache even if its route had existed.
// Callers re-read after a transition; that is why `TransitionResult` carries
// only the id and the resulting status.
//
// THE MEDICAL MODE IS DERIVED FROM THE SESSION, NOT SENT. ADR-013 gives RDF a
// board verdict (FIT/UNFIT) and RNP/RCS a certificate verdict
// (CERT_VERIFIED/CERT_REJECTED). Because the edge knows the agency from the
// officer's signed token, it picks the mode itself — which makes upstream's
// 422 INVALID_MEDICAL_INPUT structurally unreachable from a browser instead of
// a validation error the client has to learn to avoid.
//
// `retryOnG2G` is FALSE for all four. A retried transition is a double write on
// a citizen's legal record; the gateway enforces it, so no call site can opt in.
// ══════════════════════════════════════════════════════════════════

import type { HttpResult, RequestContext, Route } from '@usrp/shared-http';
import type { MedicalVerdict, TransitionOutcome } from '../../ports/upstream.js';
import type { EdgeDeps } from './deps.js';
import { withOfficerSession, type OfficerEdgeSession } from './guard.js';
import { EDGE_PATHS } from './paths.js';
import { bareError, codedError } from './responses.js';
import {
  containsForbiddenField,
  readApplicationId,
  readEnum,
  readOptionalText,
} from './validate.js';

/**
 * The column bound, not the contract's suggestion. `final_decision_notes` is a
 * varchar(1000); accepting 4000 characters would produce a 500 from the
 * database for a request the edge had already called valid.
 */
const MAX_NOTE = 1000;

/** Officer-supplied physician name on the certificate path (RNP/RCS). */
const MAX_PHYSICIAN = 200;

export function officerTransitionRoutes(deps: EdgeDeps): Route[] {
  return [
    {
      method: 'POST',
      path: EDGE_PATHS.medicalReview,
      handler: withOfficerSession(
        deps,
        async (ctx: RequestContext, session: OfficerEdgeSession): Promise<HttpResult> => {
          const parsed = await parseEnvelope(ctx);
          if (parsed.kind === 'INVALID') return parsed.result;
          const { applicationId, body } = parsed;

          let verdict: MedicalVerdict;
          if (session.agency === 'RDF') {
            const outcome = readEnum(body, 'outcome', ['FIT', 'UNFIT'] as const);
            if (outcome === null) return codedError(422, 'INVALID_MEDICAL_OUTCOME');
            verdict = { mode: 'BOARD', fitnessStatus: outcome };
          } else {
            const outcome = readEnum(body, 'outcome', [
              'CERT_VERIFIED',
              'CERT_REJECTED',
            ] as const);
            if (outcome === null) return codedError(422, 'INVALID_MEDICAL_OUTCOME');
            const physician = readOptionalText(body, 'physicianName', MAX_PHYSICIAN);
            if (!physician.ok) return codedError(422, 'INVALID_PHYSICIAN_NAME');
            verdict = {
              mode: 'CERTIFICATE',
              certVerdict: outcome,
              ...(physician.value !== null ? { physicianName: physician.value } : {}),
            };
          }
          // `note` is accepted on every transition for a consistent client
          // contract, but the medical route has no note column upstream — so it
          // is not forwarded, and that is said here rather than hidden.
          return mapTransition(
            applicationId,
            await deps.applications.medicalReview(session.credential, applicationId, verdict, {
              correlationId: ctx.correlationId,
            }),
          );
        },
      ),
    },
    {
      method: 'POST',
      path: EDGE_PATHS.finalDecision,
      handler: withOfficerSession(
        deps,
        async (ctx: RequestContext, session: OfficerEdgeSession): Promise<HttpResult> => {
          const parsed = await parseEnvelope(ctx);
          if (parsed.kind === 'INVALID') return parsed.result;
          const decision = readEnum(parsed.body, 'outcome', ['SHORTLIST', 'REJECT'] as const);
          if (decision === null) return codedError(422, 'INVALID_DECISION');
          return mapTransition(
            parsed.applicationId,
            await deps.applications.finalDecision(
              session.credential,
              parsed.applicationId,
              decision,
              parsed.note,
              { correlationId: ctx.correlationId },
            ),
          );
        },
      ),
    },
    {
      method: 'POST',
      path: EDGE_PATHS.accept,
      handler: withOfficerSession(
        deps,
        async (ctx: RequestContext, session: OfficerEdgeSession): Promise<HttpResult> => {
          const parsed = await parseEnvelope(ctx);
          if (parsed.kind === 'INVALID') return parsed.result;
          // No outcome vocabulary: acceptance is not a choice between values,
          // it is one act. Subject to the ADR-014 cross-agency lock.
          return mapTransition(
            parsed.applicationId,
            await deps.applications.accept(session.credential, parsed.applicationId, {
              correlationId: ctx.correlationId,
            }),
          );
        },
      ),
    },
    {
      method: 'POST',
      path: EDGE_PATHS.adjudicate,
      handler: withOfficerSession(
        deps,
        async (ctx: RequestContext, session: OfficerEdgeSession): Promise<HttpResult> => {
          const parsed = await parseEnvelope(ctx);
          if (parsed.kind === 'INVALID') return parsed.result;
          const decision = readEnum(parsed.body, 'outcome', ['CLEAR', 'REJECT'] as const);
          if (decision === null) return codedError(422, 'INVALID_DECISION');
          return mapTransition(
            parsed.applicationId,
            await deps.applications.adjudicate(
              session.credential,
              parsed.applicationId,
              decision,
              parsed.note,
              { correlationId: ctx.correlationId },
            ),
          );
        },
      ),
    },
  ];
}

type ParsedEnvelope =
  | {
      readonly kind: 'OK';
      readonly applicationId: string;
      readonly note: string | null;
      readonly body: unknown;
    }
  | { readonly kind: 'INVALID'; readonly result: HttpResult };

/** The shared envelope every transition carries. NOT a generic transition. */
async function parseEnvelope(ctx: RequestContext): Promise<ParsedEnvelope> {
  const body = await ctx.json<unknown>();
  if (containsForbiddenField(body)) {
    return { kind: 'INVALID', result: codedError(400, 'FORBIDDEN_FIELD') };
  }
  const applicationId = readApplicationId(body);
  if (applicationId === null) {
    return { kind: 'INVALID', result: codedError(400, 'INVALID_APPLICATION_ID') };
  }
  const note = readOptionalText(body, 'note', MAX_NOTE);
  if (!note.ok) return { kind: 'INVALID', result: codedError(422, 'INVALID_NOTE') };
  return { kind: 'OK', applicationId, note: note.value, body };
}

/**
 * Outcome → response. Shared by the four transitions, the walk-in vet and the
 * citizen withdrawal.
 *
 * NOTE WHAT IS ABSENT from the 409s: no current status, and — for the accept
 * lock — no agency. `CodedError` is `{ error, message? }` with
 * additionalProperties false precisely so a conflict cannot grow a field that
 * discloses platform state; the caller re-reads, which is the design.
 */
export function mapTransition(applicationId: string, outcome: TransitionOutcome): HttpResult {
  switch (outcome.kind) {
    case 'APPLIED':
      return { status: 200, body: { applicationId, status: outcome.toStatus } };
    case 'NO_CHANGE':
      // Already in the target state. A 200 with the CURRENT status is the honest
      // answer: the caller's intent holds, nothing moved.
      return { status: 200, body: { applicationId, status: outcome.currentStatus } };
    case 'NOT_APPLICABLE':
      return codedError(409, 'ILLEGAL_TRANSITION');
    case 'AGE_PENDING':
      // The autonomous age verdict rides the event backbone off the
      // registration; the tablet retries shortly. A distinct code so the UI can
      // say "verifying, one moment" instead of "illegal".
      return codedError(409, 'AGE_VERIFICATION_PENDING');
    case 'ACCEPT_LOCKED':
      // ADR-014: one citizen, one acceptance. The holding agency is NOT named.
      return codedError(409, 'ACCEPT_LOCK_HELD');
    case 'NOT_FOUND':
      return bareError(404);
    case 'FORBIDDEN':
      return codedError(403, 'FORBIDDEN');
    case 'UNSUPPORTED_AGENCY':
      // Walk-in is RDF-only upstream. An authorization boundary for RNP/RCS,
      // so 403 — not the 422 a "bad request" reading would suggest.
      return codedError(403, 'WALK_IN_NOT_AVAILABLE');
    case 'INVALID_INPUT':
      return codedError(422, outcome.reason);
    default:
      return assertNever(outcome);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled transition outcome: ${JSON.stringify(value)}`);
}
