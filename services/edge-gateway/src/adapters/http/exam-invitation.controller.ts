// ══════════════════════════════════════════════════════════════════
// edge-gateway — The citizen's exam QR (ADR-033)
//
//   GET /edge/v1/me/applications/exam-invitation?applicationId=   applicant
//
// The payload is the signed slot invitation (ADR-009) the portal renders as a
// downloadable QR. It is a credential, so the body is REBUILT from a closed
// allowlist and every response is already `cache-control: no-store`
// (shared-http). The payload must look like a USRP-SLOT.v1 token or the whole
// answer is a contract fault — a malformed QR is worse than none at the gate.
// ══════════════════════════════════════════════════════════════════

import type { HttpResult, RouteHandler } from '@usrp/shared-http';
import { UPSTREAM } from '../../domain/upstream-operations.js';
import { NOT_FOUND } from './outcomes.js';
import { withApplicantSession, type EdgeDeps } from './guards.js';
import { requireApplicationIdQuery } from './validation.js';

const STATES = new Set(['READY', 'PENDING', 'ON_HOLD', 'COMPLETED', 'CLOSED', 'EXPIRED', 'UNAVAILABLE', 'WALK_IN']);
const TOKEN_RE = /^USRP-SLOT\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MISMATCH: HttpResult = { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };

/** The allowlisted view, or null when the upstream shape is wrong. */
export function projectExamInvitation(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const state = v['state'];
  if (typeof state !== 'string' || !STATES.has(state)) return null;
  if (typeof v['agency'] !== 'string' || typeof v['processingCode'] !== 'string' || typeof v['currentStatus'] !== 'string') {
    return null;
  }
  const base = {
    state,
    agency: v['agency'],
    processingCode: v['processingCode'],
    campaignLabel: typeof v['campaignLabel'] === 'string' ? v['campaignLabel'] : null,
    currentStatus: v['currentStatus'],
  };
  if (state !== 'READY') return base;
  const i = v['invitation'];
  if (i === null || typeof i !== 'object') return null;
  const inv = i as Record<string, unknown>;
  const qrPayload = inv['qrPayload'];
  if (typeof qrPayload !== 'string' || qrPayload.length > 4096 || !TOKEN_RE.test(qrPayload)) return null;
  if (
    typeof inv['ticketId'] !== 'string' || typeof inv['venueName'] !== 'string' ||
    typeof inv['examDate'] !== 'string' || typeof inv['reportingTimeHour'] !== 'number' ||
    typeof inv['validUntil'] !== 'string'
  ) {
    return null;
  }
  return {
    ...base,
    invitation: {
      qrPayload,
      ticketId: inv['ticketId'],
      venueName: inv['venueName'],
      examDate: inv['examDate'],
      reportingTimeHour: inv['reportingTimeHour'],
      validUntil: inv['validUntil'],
    },
  };
}

export function getMyExamInvitationHandler(deps: EdgeDeps): RouteHandler {
  return withApplicantSession(deps, 'getMyExamInvitation', async (ctx, session) => {
    const applicationId = requireApplicationIdQuery(ctx);
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.myExamInvitation,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      query: { applicationId },
    });
    if (upstream.status === 401) return { status: 401, body: { reason: 'revoked' } };
    if (upstream.status === 404) return NOT_FOUND;
    if (upstream.status !== 200) return MISMATCH;
    const view = projectExamInvitation(upstream.body);
    return view === null ? MISMATCH : { status: 200, body: view };
  });
}
