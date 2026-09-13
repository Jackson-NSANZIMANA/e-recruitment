// ══════════════════════════════════════════════════════════════════
// edge-gateway — Identity verification (the ONE brokered service-internal route)
//
// The upstream operation is `service-internal`; ADR-012 D1 widened its withAuth
// to accept officer principals so a field officer at an exam venue can establish
// a walk-in candidate's identity with the tablet online. It is therefore named in
// exactly one place in this service — BROKERED_SERVICE_INTERNAL in the upstream
// catalogue — so the exception is an auditable line of code rather than a rule.
//
// OFFICER SESSION ONLY. An applicant-reachable NIDA check is a national identity
// enumeration oracle; citizens authenticate by OTP instead, where the 202 reveals
// nothing. Rate-limited per National ID for the same reason.
//
// THE RESPONSE IS THE RUNNING CONTROLLER'S, NOT THE STALE CONTRACT'S. The
// document described `{ verified, fullName }`. The controller returns
// `{ status: CREATED | ALREADY_EXISTS, applicantId }`. Restoring the old shape
// would put a citizen's full name in a browser payload for every NID an officer
// types — PII the walk-in lane does not need, since the next step consumes the
// opaque applicantId. The submitted National ID is never echoed back.
//
// CHANNEL IS SERVER-SET to WALK_IN. This route exists for the on-site lane, and
// the registration channel recorded against a new identity is a fact about how
// the platform met that person — not a claim a client gets to make.
// ══════════════════════════════════════════════════════════════════

import type { RouteHandler } from '@usrp/shared-http';
import { UPSTREAM } from '../../registry/upstream-operations.js';
import {
  assertWithinLimit,
  clientBucketKey,
  targetBucketKey,
} from '../../security/rate-limiter.js';
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
    assertWithinLimit(
      deps.limiter.check(
        targetBucketKey(key, 'verifyIdentity', nationalId),
        limits.verifyIdentityPerMinute,
      ),
    );
    // The per-SESSION bucket, not the per-client one: an officer session is a
    // strong identifier the caller cannot spoof, which makes it a better key
    // than an ingress-supplied address for an authenticated route.
    assertWithinLimit(
      deps.limiter.check(
        `session:${session.sessionId}:verifyIdentity`,
        limits.verifyIdentityPerMinute,
      ),
    );
    void clientBucketKey;

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.verifyIdentity,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { nationalId, channel: WALK_IN_CHANNEL },
    });

    // 201 CREATED and 200 ALREADY_EXISTS are both a successful resolution as far
    // as the console is concerned — one status code, with the distinction in the
    // body, so a caller cannot branch on HTTP codes for a business difference.
    if (upstream.status === 201 || upstream.status === 200) {
      const status = field(upstream.body, 'status');
      const applicantId = field(upstream.body, 'applicantId');
      if (typeof applicantId !== 'string' || typeof status !== 'string') {
        return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
      }
      return { status: 200, body: { status, applicantId } };
    }
    if (upstream.status === 404) {
      // An officer typed a National ID NIDA does not know. Distinguishable here
      // and only here: the caller is an authenticated, rate-limited officer
      // performing an on-site identity check, and "not found in NIDA" is the
      // answer the lane exists to obtain.
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
