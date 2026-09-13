// ══════════════════════════════════════════════════════════════════
// edge-gateway — Officer reads. Agency comes from the session, never the request.
//
// THE LIST TAKES NO PARAMETERS AND DOES NOT PAGINATE, because nothing upstream
// does: the read is capped and returns a bare array. The old frontend sent five
// parameters (status, requiresAction, page, pageSize, search) and expected a
// `PaginatedResult`; all five were silently ignored and every consumer reading
// `.items` / `.total` got `undefined`. Filtering is client-side over the capped
// result until an upstream read supports it — and when one does it arrives here
// as an explicit new operation, not as parameters bolted onto this one.
//
// THE 404 IS BARE AND MUST STAY BARE. A sibling agency's real application id and
// a wholly nonexistent one produce byte-identical responses, because upstream
// only ever queries the caller's own schema. If the two differed an officer could
// walk ids to learn what another agency is processing.
// ══════════════════════════════════════════════════════════════════

import type { HttpResult, RequestContext, Route } from '@usrp/shared-http';
import type { EdgeDeps } from './deps.js';
import { withOfficerSession, type OfficerEdgeSession } from './guard.js';
import { EDGE_PATHS } from './paths.js';
import { bareError, codedError } from './responses.js';
import { isUuid } from './validate.js';

/** Read `?applicationId=`, or null when it is absent/not a UUID. */
function queryApplicationId(ctx: RequestContext): string | null {
  const value = ctx.query.get('applicationId')?.trim() ?? '';
  return isUuid(value) ? value : null;
}

export function officerReadRoutes(deps: EdgeDeps): Route[] {
  return [
    {
      method: 'GET',
      path: EDGE_PATHS.applications,
      handler: withOfficerSession(
        deps,
        async (ctx: RequestContext, session: OfficerEdgeSession): Promise<HttpResult> => {
          const rows = await deps.applications.listApplications(session.credential, {
            correlationId: ctx.correlationId,
          });
          // The agency is echoed from the SESSION, not from upstream's response
          // body, so the row a client renders and the role the query ran under
          // cannot disagree.
          return { status: 200, body: rows.map((row) => ({ ...row, agency: session.agency })) };
        },
      ),
    },
    {
      method: 'GET',
      path: EDGE_PATHS.amberQueue,
      handler: withOfficerSession(
        deps,
        async (ctx: RequestContext, session: OfficerEdgeSession): Promise<HttpResult> => {
          const rows = await deps.applications.listAmberQueue(session.credential, {
            correlationId: ctx.correlationId,
          });
          return { status: 200, body: rows.map((row) => ({ ...row, agency: session.agency })) };
        },
      ),
    },
    {
      method: 'GET',
      path: EDGE_PATHS.applicationById,
      handler: withOfficerSession(
        deps,
        async (ctx: RequestContext, session: OfficerEdgeSession): Promise<HttpResult> => {
          const applicationId = queryApplicationId(ctx);
          // A malformed id cannot be a real one, so answering 400 here reveals
          // nothing about what exists — and it stops a client bug looking
          // exactly like a missing record for the rest of its life.
          if (applicationId === null) return codedError(400, 'INVALID_APPLICATION_ID');
          const application = await deps.applications.findById(session.credential, applicationId, {
            correlationId: ctx.correlationId,
          });
          if (application === null) return bareError(404);
          return { status: 200, body: { ...application, agency: session.agency } };
        },
      ),
    },
    {
      method: 'GET',
      path: EDGE_PATHS.statusHistory,
      handler: withOfficerSession(
        deps,
        async (ctx: RequestContext, session: OfficerEdgeSession): Promise<HttpResult> => {
          const applicationId = queryApplicationId(ctx);
          if (applicationId === null) return codedError(400, 'INVALID_APPLICATION_ID');
          const history = await deps.applications.statusHistory(session.credential, applicationId, {
            correlationId: ctx.correlationId,
          });
          if (history === null) return bareError(404);
          return { status: 200, body: history };
        },
      ),
    },
    {
      method: 'GET',
      path: EDGE_PATHS.applicationDetail,
      handler: withOfficerSession(
        deps,
        async (ctx: RequestContext, session: OfficerEdgeSession): Promise<HttpResult> => {
          const applicationId = queryApplicationId(ctx);
          if (applicationId === null) return codedError(400, 'INVALID_APPLICATION_ID');
          const upstreamCtx = { correlationId: ctx.correlationId };
          // Composed so the Procedural Justice view — actor kind, timestamp and
          // note for every decision — is ONE request rather than two the client
          // has to keep consistent. Issued in parallel: they are independent
          // reads against the same agency schema under the same credential.
          const [application, history] = await Promise.all([
            deps.applications.findById(session.credential, applicationId, upstreamCtx),
            deps.applications.statusHistory(session.credential, applicationId, upstreamCtx),
          ]);
          // Either being absent is the same indistinguishable 404.
          if (application === null || history === null) return bareError(404);
          return {
            status: 200,
            body: { application: { ...application, agency: session.agency }, history },
          };
        },
      ),
    },
  ];
}
