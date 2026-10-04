// ══════════════════════════════════════════════════════════════════
// edge-gateway — Citizen self-service
//
// SCOPED BY THE SESSION, NEVER BY A PARAMETER. There is no way to ask for, or
// act on, someone else's applications because there is nothing to ask with:
// the edge forwards the citizen's own opaque token and identity-service
// resolves the subject from it inside the read or write.
//
// Cross-agency by construction — which is why ApplicantSession carries no
// agency and why a UI asking a citizen to "choose your agency portal" would be
// modelling the officer's world. The agency of a NEW application is derived
// server-side from its category (agencyForCategory), never accepted as input.
//
// NO FORENSIC SIGNAL REACHES THIS SURFACE. A score handed to the person who
// uploaded the file is a forgery-tuning oracle.
// ══════════════════════════════════════════════════════════════════

import type { RouteHandler } from '@usrp/shared-http';
import { UPSTREAM } from '../../domain/upstream-operations.js';
import { field, projectMyApplications } from './projections.js';
import { NOT_FOUND, conflictResult } from './outcomes.js';
import { withApplicantSession, type EdgeDeps } from './guards.js';
import { optionalNote, readJsonBody, requireUuid } from './validation.js';

const MAX_REASON = 2_000;

export function listMyApplicationsHandler(deps: EdgeDeps): RouteHandler {
  return withApplicantSession(deps, 'listMyApplications', async (ctx, session) => {
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.myApplications,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
    });
    if (upstream.status === 401) {
      // The upstream token died before the edge handle did. Report it as an
      // ended session so the SPA re-authenticates instead of showing an error.
      return { status: 401, body: { reason: 'revoked' } };
    }
    if (upstream.status !== 200) return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
    return { status: 200, body: projectMyApplications(upstream.body) };
  });
}

/**
 * Withdraw one's own application. Ownership is enforced UPSTREAM, inside the
 * write transaction, against the session subject — not against a body field.
 *
 * `reason` is validated and NOT forwarded: the upstream route has no such field.
 */
export function withdrawMyApplicationHandler(deps: EdgeDeps): RouteHandler {
  return withApplicantSession(deps, 'withdrawMyApplication', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    const applicationId = requireUuid(body.applicationId, 'applicationId');
    // Validated then discarded, so an over-long or NID-bearing value is still a
    // 400 rather than accepted-and-ignored.
    void optionalNote(body.reason, MAX_REASON);

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.myWithdraw,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { applicationId },
    });

    if (upstream.status === 200) {
      const status = field(upstream.body, 'status');
      const agency = field(upstream.body, 'agency');
      return {
        status: 200,
        body: {
          applicationId,
          outcome: typeof status === 'string' ? status : 'WITHDRAWN',
          agency: typeof agency === 'string' ? agency : null,
          fromStatus: field(upstream.body, 'fromStatus') ?? null,
        },
      };
    }
    if (upstream.status === 404) return NOT_FOUND;
    if (upstream.status === 409) return conflictResult(upstream.body);
    if (upstream.status === 401) return { status: 401, body: { reason: 'revoked' } };
    return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
  });
}

/**
 * Erasure-request status (Law N° 058/2021 data-subject right). The upstream 404
 * becomes a 200 `{ exists: false }`: "you have no open request" is an ANSWER.
 */
export function getMyErasureRequestHandler(deps: EdgeDeps): RouteHandler {
  return withApplicantSession(deps, 'getMyErasureRequest', async (ctx, session) => {
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.myErasureRequestGet,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
    });
    if (upstream.status === 404) return { status: 200, body: { exists: false } };
    if (upstream.status === 401) return { status: 401, body: { reason: 'revoked' } };
    if (upstream.status !== 200) return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
    return {
      status: 200,
      body: {
        exists: true,
        requestId: field(upstream.body, 'requestId') ?? null,
        status: field(upstream.body, 'status') ?? null,
        filedAt: field(upstream.body, 'requestedAt') ?? null,
        decidedAt: field(upstream.body, 'decidedAt') ?? null,
        decisionNote: field(upstream.body, 'decisionNote') ?? null,
      },
    };
  });
}

/** File an erasure request. 202 both ways — erasure is adjudicated, not immediate. */
export function fileMyErasureRequestHandler(deps: EdgeDeps): RouteHandler {
  return withApplicantSession(deps, 'fileMyErasureRequest', async (ctx, session) => {
    // The upstream intake takes no body; filing is idempotent upstream.
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.myErasureRequestFile,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: {},
    });
    if (upstream.status === 202 || upstream.status === 200) {
      return {
        status: 202,
        body: { accepted: true, requestId: field(upstream.body, 'requestId') ?? null },
      };
    }
    if (upstream.status === 401) return { status: 401, body: { reason: 'revoked' } };
    if (upstream.status === 409) return { status: 409, body: { error: 'REQUEST_ALREADY_OPEN' } };
    return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
  });
}
