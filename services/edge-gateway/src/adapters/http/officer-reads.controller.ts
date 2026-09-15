// ══════════════════════════════════════════════════════════════════
// edge-gateway — Officer reads
//
// AGENCY COMES FROM THE SESSION ON EVERY ONE OF THESE. Not from a path segment,
// a query parameter, a body field or a header — the edge does not even forward
// it, because the upstream reads derive it from the officer token the edge is
// holding and run under that officer's own PostgreSQL role. There is nothing
// here for a client to tamper with, which is a stronger property than validating
// a field they could have sent.
//
// THE LIST TAKES NO PARAMETERS AND DOES NOT PAGINATE. The old frontend sent
// five (`status`, `requiresAction`, `page`, `pageSize`, `search`) and expected a
// PaginatedResult; all five were silently ignored and every consumer reading
// `.items` / `.total` got undefined. The upstream read is capped and returns a
// bare array. When an upstream read supports filtering it arrives here as an
// explicit new operation, not as parameters bolted onto this one.
// ══════════════════════════════════════════════════════════════════

import type { RouteHandler } from '@usrp/shared-http';
import { UPSTREAM } from '../../registry/upstream-operations.js';
import {
  projectAmberQueue,
  projectApplication,
  projectListItems,
  projectStatusHistory,
} from './projections.js';
import { FORBIDDEN, NOT_FOUND } from './outcomes.js';
import { withOfficerSession, type EdgeDeps } from './guards.js';
import { requireApplicationIdQuery } from './validation.js';

export function listApplicationsHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'listApplications', async (ctx, session, agency) => {
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.listApplications,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
    });
    if (upstream.status === 403) return FORBIDDEN;
    if (upstream.status !== 200) return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
    return { status: 200, body: projectListItems(upstream.body, agency) };
  });
}

export function listAmberQueueHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'listAmberQueue', async (ctx, session, agency) => {
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.amberQueue,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
    });
    if (upstream.status === 403) return FORBIDDEN;
    if (upstream.status !== 200) return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
    return { status: 200, body: projectAmberQueue(upstream.body, agency) };
  });
}

export function findApplicationByIdHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'findApplicationById', async (ctx, session, agency) => {
    const applicationId = requireApplicationIdQuery(ctx);
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.applicationById,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      query: { applicationId },
    });
    // 404 is byte-identical for a nonexistent id and a sibling agency's real
    // one. That conflation IS the control — do not enrich it.
    if (upstream.status === 404) return NOT_FOUND;
    if (upstream.status === 403) return FORBIDDEN;
    if (upstream.status !== 200) return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
    const application = projectApplication(upstream.body, agency);
    if (application === null) return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
    return { status: 200, body: application };
  });
}

/**
 * The Procedural Justice view: the record AND its decision trail in one round
 * trip, because a field tablet on a slow link should not need two.
 *
 * The record is fetched FIRST and its 404 short-circuits: if the application is
 * not in this officer's agency there is no trail to ask about, and asking anyway
 * would make the second call's timing a weak existence oracle.
 */
export function getApplicationDetailHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'getApplicationDetail', async (ctx, session, agency) => {
    const applicationId = requireApplicationIdQuery(ctx);

    const record = await deps.upstream.call({
      operation: UPSTREAM.applicationById,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      query: { applicationId },
    });
    if (record.status === 404) return NOT_FOUND;
    if (record.status === 403) return FORBIDDEN;
    if (record.status !== 200) return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };

    const application = projectApplication(record.body, agency);
    if (application === null) return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };

    const trail = await deps.upstream.call({
      operation: UPSTREAM.statusHistory,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      query: { applicationId },
    });
    if (trail.status === 404) return NOT_FOUND;
    if (trail.status !== 200) return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };

    return {
      status: 200,
      body: { application, history: projectStatusHistory(trail.body) },
    };
  });
}

export function getApplicationStatusHistoryHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'getApplicationStatusHistory', async (ctx, session) => {
    const applicationId = requireApplicationIdQuery(ctx);
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.statusHistory,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      query: { applicationId },
    });
    if (upstream.status === 404) return NOT_FOUND;
    if (upstream.status === 403) return FORBIDDEN;
    if (upstream.status !== 200) return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
    return { status: 200, body: projectStatusHistory(upstream.body) };
  });
}
