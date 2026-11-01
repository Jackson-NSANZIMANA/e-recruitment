// ══════════════════════════════════════════════════════════════════
// edge-gateway — The FOUR transitions
//
// Four separately-guarded decisions, four routes, four request shapes. They are
// separate because they carry different authority; collapsing them into a
// generic field write is a broken authorization model, not a URL style choice.
// There is no PATCH and no DELETE anywhere on this boundary.
//
// EACH BODY IS TRANSCRIBED FROM THE RUNNING CONTROLLER, not from the shared
// envelope the stale contract described:
//
//   medical-review  { applicationId, fitnessStatus? | certVerdict?, physicianName? }
//                   Two agency MODES (ADR-013): BOARD (RDF) sends fitnessStatus,
//                   CERTIFICATE (RNP/RCS) sends certVerdict (+ physicianName when
//                   verified). WHICH mode the caller may use is the upstream's
//                   decision, derived from the officer principal — the edge
//                   validates shape only and lets a mismatch surface as 422.
//                   It carries NO note: the upstream route has no such field.
//   final-decision  { applicationId, decision: SHORTLIST|REJECT, notes? }
//   accept          { applicationId }
//   adjudicate      { applicationId, decision: CLEAR|REJECT, notes? }
//   vetting-hold    { applicationId, dimension: CRIMINAL|ACADEMIC,
//                     decision: CLEAR|REJECT, reasonCode, notes? }   (D10, ADR-051)
//
// NONE RETURNS AN APPLICATION. The old frontend hook was typed
// UseMutationResult<Application> and wrote the response into its detail cache,
// which would have poisoned the cache even if the route had existed. Callers
// re-read after a transition.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type RouteHandler } from '@usrp/shared-http';
import { VETTING_HOLD_REASONS, type VettingHoldReason } from '@usrp/shared-types';
import { UPSTREAM } from '../../domain/upstream-operations.js';
import { transitionResult } from './outcomes.js';
import { withOfficerSession, type EdgeDeps } from './guards.js';
import {
  optionalBoundedString,
  optionalNote,
  readJsonBody,
  requireOneOf,
  requireUuid,
} from './validation.js';

const FITNESS: ReadonlySet<string> = new Set(['FIT', 'UNFIT']);
const CERT_VERDICTS: ReadonlySet<string> = new Set(['CERT_VERIFIED', 'CERT_REJECTED']);
const DECISIONS: ReadonlySet<'SHORTLIST' | 'REJECT'> = new Set(['SHORTLIST', 'REJECT']);
const ADJUDICATIONS: ReadonlySet<'CLEAR' | 'REJECT'> = new Set(['CLEAR', 'REJECT']);
/** D10: the vetting-hold vocabulary, imported — never retyped on this boundary. */
const VETTING_DIMENSIONS: ReadonlySet<'CRIMINAL' | 'ACADEMIC'> = new Set(['CRIMINAL', 'ACADEMIC']);
const VETTING_REASON_CODES: ReadonlySet<VettingHoldReason> = new Set(
  Object.keys(VETTING_HOLD_REASONS) as VettingHoldReason[],
);
/** final_decision_notes is varchar(1000) upstream. */
const MAX_NOTES = 1_000;
const MAX_PHYSICIAN = 200;

export function recordMedicalReviewHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'recordMedicalReview', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    const applicationId = requireUuid(body.applicationId, 'applicationId');

    const hasFitness = body.fitnessStatus !== undefined && body.fitnessStatus !== null;
    const hasCert = body.certVerdict !== undefined && body.certVerdict !== null;
    if (!hasFitness && !hasCert) {
      throw new HttpError(
        400,
        'INVALID_REQUEST',
        'Send "fitnessStatus" (board agency) or "certVerdict" (certificate agency).',
      );
    }
    if (hasFitness && hasCert) {
      // Sending both is not "be liberal in what you accept" — it is a caller who
      // does not know which medical model their own agency uses, and forwarding
      // both would let the upstream pick.
      throw new HttpError(
        400,
        'INVALID_REQUEST',
        'Send exactly one of "fitnessStatus" or "certVerdict".',
      );
    }

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.medicalReview,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: {
        applicationId,
        ...(hasFitness
          ? { fitnessStatus: requireOneOf(body.fitnessStatus, 'fitnessStatus', FITNESS) }
          : {}),
        ...(hasCert
          ? { certVerdict: requireOneOf(body.certVerdict, 'certVerdict', CERT_VERDICTS) }
          : {}),
        ...(body.physicianName === undefined || body.physicianName === null
          ? {}
          : {
              physicianName: optionalBoundedString(
                body.physicianName,
                'physicianName',
                MAX_PHYSICIAN,
              ),
            }),
      },
    });
    return transitionResult(applicationId, upstream.status, upstream.body);
  });
}

export function recordFinalDecisionHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'recordFinalDecision', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    const applicationId = requireUuid(body.applicationId, 'applicationId');
    const decision = requireOneOf<'SHORTLIST' | 'REJECT'>(body.decision, 'decision', DECISIONS);
    const notes = optionalNote(body.notes ?? body.note, MAX_NOTES);

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.finalDecision,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { applicationId, decision, ...(notes === undefined ? {} : { notes }) },
    });
    return transitionResult(applicationId, upstream.status, upstream.body);
  });
}

export function acceptApplicationHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'acceptApplication', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    const applicationId = requireUuid(body.applicationId, 'applicationId');
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.accept,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { applicationId },
    });
    // The ADR-014 cross-agency lock surfaces as a 409 whose body does NOT name
    // the holding agency — stripped in outcomes.ts.
    return transitionResult(applicationId, upstream.status, upstream.body);
  });
}

export function adjudicateApplicationHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'adjudicateApplication', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    const applicationId = requireUuid(body.applicationId, 'applicationId');
    const decision = requireOneOf<'CLEAR' | 'REJECT'>(body.decision, 'decision', ADJUDICATIONS);
    const notes = optionalNote(body.notes ?? body.note, MAX_NOTES);

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.adjudicate,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { applicationId, decision, ...(notes === undefined ? {} : { notes }) },
    });
    return transitionResult(applicationId, upstream.status, upstream.body);
  });
}

/**
 * D10 (ADR-051): resolve a HELD vetting dimension — the verb the amber queue
 * never had. The edge is a pass-through on the MEANING (the reason set is owned
 * by @usrp/shared-types and enforced again upstream), but it is not a
 * pass-through on SHAPE: an unknown reason code or dimension never leaves this
 * boundary, and the closed vocabulary is one import, so the console's dropdown
 * and the service's table cannot drift.
 *
 * The response says which dimension moved and whether the STATUS moved — a late
 * hold resolved on an already-scheduled application legitimately keeps its
 * status, and the console must be able to tell that apart from a no-op.
 */
export function resolveVettingHoldHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'resolveVettingHold', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    const applicationId = requireUuid(body.applicationId, 'applicationId');
    const dimension = requireOneOf<'CRIMINAL' | 'ACADEMIC'>(body.dimension, 'dimension', VETTING_DIMENSIONS);
    const decision = requireOneOf<'CLEAR' | 'REJECT'>(body.decision, 'decision', ADJUDICATIONS);
    const reasonCode = requireOneOf<VettingHoldReason>(body.reasonCode, 'reasonCode', VETTING_REASON_CODES);
    const notes = optionalNote(body.notes ?? body.note, MAX_NOTES);

    // The reason IS the verdict. Refuse the contradiction here, with the same
    // closed rule the service enforces (422 upstream) — so a console bug shows
    // up in the edge's own tests rather than as a rejected officer.
    const spec = VETTING_HOLD_REASONS[reasonCode];
    if (spec.dimension !== dimension || spec.decision !== decision) {
      throw new HttpError(
        422,
        'INVALID_VETTING_HOLD_REASON',
        `reasonCode ${reasonCode} resolves ${spec.dimension}/${spec.decision}, not ${dimension}/${decision}.`,
      );
    }

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.vettingHold,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { applicationId, dimension, decision, reasonCode, ...(notes === undefined ? {} : { notes }) },
    });
    return transitionResult(applicationId, upstream.status, upstream.body);
  });
}
