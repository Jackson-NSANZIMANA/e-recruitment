// ══════════════════════════════════════════════════════════════════
// edge-gateway — Citizen self-service. Cross-agency by construction.
//
// EVERY ROUTE HERE IS SCOPED BY THE SESSION AND BY NOTHING ELSE. There is no
// applicantId parameter anywhere, so there is no way to ask for someone else's
// applications — not because a check rejects it, but because there is nothing
// to ask with. Ownership on the write path is enforced upstream against the
// session subject inside the write transaction, never against a body field.
//
// `listMyApplications` unions all three ops schemas: a citizen who cross-applies
// is the one legitimately shared case, ADR-014's accept lock spans all three
// agencies, and `ApplicantSession` therefore carries no agency at all. A UI that
// asks a citizen to "choose your agency portal" is modelling the officer's world.
//
// NOTHING FORENSIC IS RETURNED ON ANY ROUTE IN THIS FILE. A lane, score or flag
// handed to the person who uploaded the document is a forgery-tuning oracle:
// edit, re-upload, watch the number move, repeat until GREEN.
// ══════════════════════════════════════════════════════════════════

import type { HttpResult, RequestContext, Route } from '@usrp/shared-http';
import type { EdgeDeps } from './deps.js';
import { withApplicantSession, type ApplicantEdgeSession } from './guard.js';
import { mapTransition } from './officer-transitions.controller.js';
import { EDGE_PATHS } from './paths.js';
import { bareAccepted, codedError } from './responses.js';
import { containsForbiddenField, readApplicationId, readOptionalText } from './validate.js';

const MAX_REASON = 2000;

export function citizenRoutes(deps: EdgeDeps): Route[] {
  return [
    {
      method: 'GET',
      path: EDGE_PATHS.myApplications,
      handler: withApplicantSession(
        deps,
        async (ctx: RequestContext, session: ApplicantEdgeSession): Promise<HttpResult> => {
          const rows = await deps.identity.listMyApplications(session.credential, {
            correlationId: ctx.correlationId,
          });
          return { status: 200, body: rows };
        },
      ),
    },
    {
      method: 'POST',
      path: EDGE_PATHS.withdrawMyApplication,
      handler: withApplicantSession(
        deps,
        async (ctx: RequestContext, session: ApplicantEdgeSession): Promise<HttpResult> => {
          const body = await ctx.json<unknown>();
          if (containsForbiddenField(body)) return codedError(400, 'FORBIDDEN_FIELD');
          const applicationId = readApplicationId(body);
          if (applicationId === null) return codedError(400, 'INVALID_APPLICATION_ID');
          const reason = readOptionalText(body, 'reason', MAX_REASON);
          if (!reason.ok) return codedError(422, 'INVALID_REASON');
          // `reason` is ACCEPTED and NOT FORWARDED: the upstream withdraw route
          // takes only an applicationId, so there is no column for it. Accepting
          // it keeps the client contract stable; pretending it was stored would
          // be worse than either dropping or rejecting it, so it is dropped
          // here, in the open, and recorded in docs/CONTRACT-DEVIATIONS.md.
          return mapTransition(
            applicationId,
            await deps.identity.withdrawMyApplication(session.credential, applicationId, {
              correlationId: ctx.correlationId,
            }),
          );
        },
      ),
    },
    {
      method: 'GET',
      path: EDGE_PATHS.myErasureRequest,
      handler: withApplicantSession(
        deps,
        async (ctx: RequestContext, session: ApplicantEdgeSession): Promise<HttpResult> => {
          const outcome = await deps.identity.getMyErasureRequest(session.credential, {
            correlationId: ctx.correlationId,
          });
          if (outcome.kind === 'NONE') {
            // An explicit ABSENCE, not a 404. This is a Law N° 058/2021 data
            // subject right; "you have no request on file" is a legitimate
            // answer to a legitimate question, not an error condition the SPA
            // should route through an error boundary.
            return { status: 200, body: { exists: false } };
          }
          return {
            status: 200,
            body: {
              exists: true,
              status: outcome.status,
              filedAt: outcome.filedAt,
              decidedAt: outcome.decidedAt,
              // The GROUND for a decision is the citizen's to see — it is the
              // answer to THEIR demand. Withholding it would leave the right
              // formally honoured and practically empty.
              decisionNote: outcome.decisionNote,
            },
          };
        },
      ),
    },
    {
      method: 'POST',
      path: EDGE_PATHS.myErasureRequest,
      handler: withApplicantSession(
        deps,
        async (ctx: RequestContext, session: ApplicantEdgeSession): Promise<HttpResult> => {
          // Note the same exact path serving GET and POST: shared-http keys its
          // table by (path → method), so two methods on one path is legal and is
          // how the upstream constant is shaped.
          await deps.identity.fileMyErasureRequest(session.credential, {
            correlationId: ctx.correlationId,
          });
          // Erasure is ADJUDICATED, not immediate: filing is a demand on record,
          // and the DPO queue answers it. Filing twice is idempotent upstream, so
          // there is no conflict to report.
          return bareAccepted();
        },
      ),
    },
  ];
}
