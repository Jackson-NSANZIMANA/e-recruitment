// ══════════════════════════════════════════════════════════════════
// edge-gateway — Identity verification (the ONE brokered service-internal route)
//
// The upstream operation is `service-internal`; ADR-012 D1 widened its withAuth
// to accept officer principals so a field officer at an exam venue can establish
// a walk-in candidate's identity with the tablet online. It is named in exactly
// one place in this service — BROKERED_SERVICE_INTERNAL in the upstream
// catalogue — so the exception is an auditable line of code rather than a rule.
//
// OFFICER SESSION ONLY. An applicant-reachable NIDA check is a national identity
// enumeration oracle. Rate-limited per National ID AND per session.
//
// THE RESPONSE IS THE RUNNING CONTROLLER'S: `{ status, applicantId }`. No full
// name reaches the browser, and the submitted National ID is never echoed back.
//
// CHANNEL IS SERVER-SET to WALK_IN.
// ══════════════════════════════════════════════════════════════════

import type { RouteHandler } from '@usrp/shared-http';
import { UPSTREAM } from '../../domain/upstream-operations.js';
import { enforceRateLimit, sessionBucketKey, targetBucketKey } from './rate-limit.js';
import { field } from './projections.js';
import { FORBIDDEN } from './outcomes.js';
import { withOfficerSession, type EdgeDeps } from './guards.js';
import { readJsonBody, requireNationalId } from './validation.js';

const WALK_IN_CHANNEL = 'WALK_IN';

export function verifyIdentityHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'verifyIdentity', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    const nationalId = requireNationalId(body.nationalId);

    const limits = deps.config.rateLimits;
    const key = deps.config.session.handleHmacKey;
    await enforceRateLimit(
      deps.limiter,
      targetBucketKey(key, 'verifyIdentity', nationalId),
      limits.verifyIdentityPerMinute,
    );
    // The per-SESSION bucket, not the per-client one: an officer session is a
    // strong identifier the caller cannot spoof.
    await enforceRateLimit(
      deps.limiter,
      sessionBucketKey(session.sessionId, 'verifyIdentity'),
      limits.verifyIdentityPerMinute,
    );

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.verifyIdentity,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { nationalId, channel: WALK_IN_CHANNEL },
    });

    // 201 CREATED and 200 ALREADY_EXISTS are both a successful resolution: one
    // status code, with the distinction in the body.
    if (upstream.status === 201 || upstream.status === 200) {
      const status = field(upstream.body, 'status');
      const applicantId = field(upstream.body, 'applicantId');
      if (typeof applicantId !== 'string' || typeof status !== 'string') {
        return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
      }
      return { status: 200, body: { status, applicantId } };
    }
    if (upstream.status === 404) {
      // Distinguishable here and only here: the caller is an authenticated,
      // rate-limited officer and "not found in NIDA" is the answer the lane
      // exists to obtain.
      return { status: 404, body: { error: 'NOT_FOUND_IN_NIDA' } };
    }
    if (upstream.status === 422) {
      return { status: 422, body: { error: 'NOT_A_CITIZEN' } };
    }
    if (upstream.status === 403) return FORBIDDEN;
    if (upstream.status === 400) return { status: 400, body: { error: 'INVALID_REQUEST' } };
    return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
  });
}
