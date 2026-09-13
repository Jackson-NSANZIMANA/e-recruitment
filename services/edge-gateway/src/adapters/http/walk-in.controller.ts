// ══════════════════════════════════════════════════════════════════
// edge-gateway — Walk-in registration and on-site vetting
//
// THE STALE CONTRACT WAS WRONG ABOUT THIS BODY AND IT MATTERED.
//
// It described `{ nationalId, postCode }`. The running controller expects
// `{ applicantId, category, nesaIndexNumber?, hecRegistrationNumber? }`. There
// is no postCode anywhere upstream, and the walk-in lane does not resolve
// identity — that already happened at `POST /edge/v1/identities/verify`, which
// returns the opaque applicantId this route consumes. A browser sending a raw
// National ID here would have been sending PII to a route that has no use for it.
//
// The two-step is the design: verify identity against NIDA server-side, get an
// opaque handle, register with the handle. The National ID never enters this
// request at all, which is strictly better than accepting and discarding it.
//
// RDF-ONLY UPSTREAM. The WALK_IN_* statuses exist only in
// rdf_ops.application_status, which is why the backend compares status::text
// rather than casting (ADR-017 / ADR-020). An RNP or RCS officer gets a 403,
// not a 422 and not a 501: the condition is permanent and it is about authority.
//
// qrInvitationCode IS returned — it is the on-site ticket the field officer
// prints or shows, and withholding it would break the lane it exists for. It is
// a bearer credential, so it is on the redaction deny-list and never logged.
// ══════════════════════════════════════════════════════════════════

import type { RouteHandler } from '@usrp/shared-http';
import { ALL_CATEGORIES } from '@usrp/shared-types';
import { UPSTREAM } from '../../registry/upstream-operations.js';
import { field } from './projections.js';
import {
  FORBIDDEN,
  NOT_FOUND,
  UNSUPPORTED_AGENCY,
  conflictResult,
  transitionResult,
  validationResult,
} from './outcomes.js';
import { withOfficerSession, type EdgeDeps } from './guards.js';
import {
  optionalBoundedString,
  readJsonBody,
  requireOneOf,
  requireUuid,
} from './validation.js';

const CATEGORIES: ReadonlySet<string> = ALL_CATEGORIES;
const MAX_ACADEMIC_REF = 64;

export function registerWalkInHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'registerWalkIn', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    const applicantId = requireUuid(body.applicantId, 'applicantId');
    const category = requireOneOf(body.category, 'category', CATEGORIES);
    const nesaIndexNumber = optionalBoundedString(
      body.nesaIndexNumber,
      'nesaIndexNumber',
      MAX_ACADEMIC_REF,
    );
    const hecRegistrationNumber = optionalBoundedString(
      body.hecRegistrationNumber,
      'hecRegistrationNumber',
      MAX_ACADEMIC_REF,
    );

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.walkInRegister,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: {
        applicantId,
        category,
        ...(nesaIndexNumber === undefined ? {} : { nesaIndexNumber }),
        ...(hecRegistrationNumber === undefined ? {} : { hecRegistrationNumber }),
      },
    });

    if (upstream.status === 201) {
      return {
        status: 201,
        body: {
          status: 'REGISTERED',
          applicationId: field(upstream.body, 'applicationId'),
          processingCode: field(upstream.body, 'processingCode'),
          qrInvitationCode: field(upstream.body, 'qrInvitationCode'),
        },
      };
    }
    if (upstream.status === 403) return FORBIDDEN;
    if (upstream.status === 501) return UNSUPPORTED_AGENCY;
    if (upstream.status === 404) return NOT_FOUND;
    if (upstream.status === 409) return conflictResult(upstream.body);
    if (upstream.status === 422) return validationResult(upstream.body);
    return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
  });
}

/**
 * On-site vetting. `409 AGE_PENDING` is preserved verbatim: the autonomous age
 * verdict rides the event backbone off registration, so the tablet's correct
 * behaviour is to retry in a moment. Collapsing it into a generic conflict would
 * leave the field officer with no way to tell "wait" from "this cannot proceed".
 */
export function vetWalkInHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'vetWalkIn', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    const applicationId = requireUuid(body.applicationId, 'applicationId');
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.walkInVet,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { applicationId },
    });
    if (upstream.status === 200) {
      // The vet route's APPLIED body carries fromStatus/toStatus/ageStatus. The
      // shared transition projection covers the first two; ageStatus is added
      // because the tablet renders it directly.
      const projected = transitionResult(applicationId, 200, upstream.body);
      const ageStatus = field(upstream.body, 'ageStatus');
      return {
        status: 200,
        body: {
          ...(projected.body as Record<string, unknown>),
          ...(typeof ageStatus === 'string' ? { ageStatus } : {}),
        },
      };
    }
    return transitionResult(applicationId, upstream.status, upstream.body);
  });
}
