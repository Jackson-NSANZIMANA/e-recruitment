// ══════════════════════════════════════════════════════════════════
// edge-gateway — Operational reads and the DPO queue (ADR-039)
//
//   GET  /edge/v1/campaigns/admin           campaign.read.admin    listAgencyCampaigns
//   GET  /edge/v1/campaigns/admin/detail    campaign.read.admin    getCampaignAdminDetail
//   GET  /edge/v1/applications/search       application.read       searchApplications
//   GET  /edge/v1/gate/roster               admission.gate | field.score.sync   getVenueRoster
//   GET  /edge/v1/erasure-requests          erasure.queue.read     listErasureRequests
//   POST /edge/v1/erasure-requests/decision erasure.decide         decideErasureRequest
//
// AGENCY IS THE SESSION'S. No query key here can carry one (`agency` is not in any
// allowlist, and an unknown key is a 400, not ignored). The query forwarded
// upstream is REBUILT from validated values — never the browser's string.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type RequestContext, type RouteHandler } from '@usrp/shared-http';
import { UPSTREAM } from '../../domain/upstream-operations.js';
import { withOfficerSession, type EdgeDeps } from './guards.js';
import { FORBIDDEN, NOT_FOUND } from './outcomes.js';
import {
  projectAgencyCampaignList,
  projectApplicationSearch,
  projectCampaignAdminDetail,
  projectErasureQueue,
  projectVenueRoster,
} from './operational-projections.js';
import { readJsonBody, requireUuid } from './validation.js';

const MISMATCH: HttpResult = { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
const UNAVAILABLE: HttpResult = { status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } };
const BAD: HttpResult = { status: 400, body: { error: 'INVALID_REQUEST' } };
const SESSION_ENDED: HttpResult = { status: 401, body: { reason: 'revoked' } };

const PUBLIC_CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,63}$/;
const TOKEN_RE = /^[A-Z][A-Z0-9_]{1,47}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,256}$/;
const LIMIT_RE = /^\d{1,3}$/;

/** Common non-success statuses of a read. Null = not one of them. */
function failure(status: number): HttpResult | null {
  if (status === 400) return BAD;
  if (status === 401) return SESSION_ENDED;
  if (status === 403) return FORBIDDEN;
  if (status === 404) return NOT_FOUND;
  if (status === 503) return UNAVAILABLE;
  return null;
}

/**
 * Rebuild the query: only `allowed` keys, each at most once, each value passed
 * through its validator. Anything else is a 400.
 */
function rebuildQuery(
  ctx: RequestContext,
  rules: Readonly<Record<string, (raw: string) => string | null>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of new Set(ctx.query.keys())) {
    const rule = rules[key];
    if (rule === undefined) throw new HttpError(400, 'INVALID_REQUEST', `Query "${key}" is not accepted.`);
    const values = ctx.query.getAll(key);
    // `status` alone may repeat; the rest are single-valued.
    if (values.length > 1 && key !== 'status') throw new HttpError(400, 'INVALID_REQUEST', `Query "${key}" may be given once.`);
    const checked = values.map((v) => {
      const result = rule(v.trim());
      if (result === null) throw new HttpError(400, 'INVALID_REQUEST', `Query "${key}" is invalid.`);
      return result;
    });
    if (key === 'status' && checked.length > 24) throw new HttpError(400, 'INVALID_REQUEST', 'Too many statuses.');
    const value = checked.filter((v) => v !== '').join(',');
    if (value !== '') out[key] = value;
  }
  return out;
}

const pattern = (re: RegExp, upper = false) => (raw: string): string | null => {
  const v = upper ? raw.toUpperCase() : raw;
  return v === '' || re.test(v) ? v : null;
};
const statusList = (raw: string): string | null => {
  const parts = raw.split(',').map((p) => p.trim().toUpperCase()).filter((p) => p !== '');
  return parts.every((p) => TOKEN_RE.test(p)) ? parts.join(',') : null;
};
const hasControlChar = (raw: string): boolean => {
  for (let i = 0; i < raw.length; i += 1) if (raw.charCodeAt(i) < 0x20) return true;
  return false;
};
const text = (raw: string): string | null => (raw.length <= 64 && !hasControlChar(raw) ? raw : null);
const limit = (raw: string): string | null => (LIMIT_RE.test(raw) ? raw : null);

export function listAgencyCampaignsHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'listAgencyCampaigns', async (ctx, session) => {
    const query = rebuildQuery(ctx, { q: text, status: statusList, limit, cursor: pattern(CURSOR_RE) });
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.adminCampaignList, correlationId: ctx.correlationId, credential: session.upstreamCredential, query,
    });
    if (upstream.status === 200) {
      const body = projectAgencyCampaignList(upstream.body);
      return body === null ? MISMATCH : { status: 200, body };
    }
    return failure(upstream.status) ?? MISMATCH;
  });
}

export function getCampaignAdminDetailHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'getCampaignAdminDetail', async (ctx, session) => {
    const query = rebuildQuery(ctx, { publicCode: pattern(PUBLIC_CODE_RE, true) });
    if (query['publicCode'] === undefined) throw new HttpError(400, 'INVALID_PUBLIC_CODE');
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.adminCampaignDetail, correlationId: ctx.correlationId, credential: session.upstreamCredential, query,
    });
    if (upstream.status === 200) {
      const body = projectCampaignAdminDetail(upstream.body);
      return body === null ? MISMATCH : { status: 200, body };
    }
    return failure(upstream.status) ?? MISMATCH;
  });
}

export function searchApplicationsHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'searchApplications', async (ctx, session) => {
    const query = rebuildQuery(ctx, {
      status: statusList,
      category: pattern(TOKEN_RE, true),
      campaign: pattern(PUBLIC_CODE_RE, true),
      district: pattern(TOKEN_RE, true),
      submittedFrom: pattern(DAY_RE),
      submittedTo: pattern(DAY_RE),
      limit,
      cursor: pattern(CURSOR_RE),
    });
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.searchApplications, correlationId: ctx.correlationId, credential: session.upstreamCredential, query,
    });
    if (upstream.status === 200) {
      const body = projectApplicationSearch(upstream.body);
      return body === null ? MISMATCH : { status: 200, body };
    }
    return failure(upstream.status) ?? MISMATCH;
  });
}

export function getVenueRosterHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'getVenueRoster', async (ctx, session) => {
    const query = rebuildQuery(ctx, {
      campaign: pattern(PUBLIC_CODE_RE, true),
      district: pattern(TOKEN_RE, true),
      examDate: pattern(DAY_RE),
    });
    if (query['campaign'] === undefined || query['district'] === undefined || query['examDate'] === undefined) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Queries "campaign", "district" and "examDate" are required.');
    }
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.venueRoster, correlationId: ctx.correlationId, credential: session.upstreamCredential, query,
    });
    if (upstream.status === 200) {
      const body = projectVenueRoster(upstream.body);
      return body === null ? MISMATCH : { status: 200, body };
    }
    return failure(upstream.status) ?? MISMATCH;
  });
}

export function listErasureRequestsHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'listErasureRequests', async (ctx, session) => {
    if (ctx.query.toString().length !== 0) throw new HttpError(400, 'INVALID_REQUEST');
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.erasureQueue, correlationId: ctx.correlationId, credential: session.upstreamCredential,
    });
    if (upstream.status === 200) {
      const body = projectErasureQueue(upstream.body);
      return body === null ? MISMATCH : { status: 200, body };
    }
    return failure(upstream.status) ?? MISMATCH;
  });
}

const MAX_GROUNDS = 200; // erasure_requests.decision_note varchar(200)

function statusOf(raw: unknown): string | null {
  return raw !== null && typeof raw === 'object' && typeof (raw as Record<string, unknown>)['status'] === 'string'
    ? ((raw as Record<string, unknown>)['status'] as string)
    : null;
}

/**
 * The DPO's decision. DECLINE needs written grounds (the citizen sees them).
 * EXECUTE runs the existing gated erasure road (ADR-015): the applicant is
 * resolved here from the pending queue, so the browser never holds an applicant
 * id, and the upstream's own refusals (active application, accept lock) cross
 * as bare codes — the holding agency never does.
 */
export function decideErasureRequestHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'decideErasureRequest', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    for (const key of Object.keys(body)) {
      if (!['requestId', 'decision', 'grounds'].includes(key)) {
        throw new HttpError(400, 'INVALID_REQUEST', `Field "${key}" is not accepted.`);
      }
    }
    const requestId = requireUuid(body['requestId'], 'requestId');
    const decision = body['decision'];
    if (decision !== 'DECLINE' && decision !== 'EXECUTE') {
      throw new HttpError(400, 'INVALID_REQUEST', 'Field "decision" must be DECLINE or EXECUTE.');
    }

    if (decision === 'DECLINE') {
      const grounds = body['grounds'];
      if (typeof grounds !== 'string' || grounds.trim().length === 0 || grounds.length > MAX_GROUNDS) {
        throw new HttpError(400, 'GROUNDS_REQUIRED', `Declining needs written grounds (1-${String(MAX_GROUNDS)} characters).`);
      }
      const upstream = await deps.upstream.call({
        operation: UPSTREAM.erasureDecline, correlationId: ctx.correlationId, credential: session.upstreamCredential,
        body: { requestId, note: grounds.trim() },
      });
      if (upstream.status === 200 && statusOf(upstream.body) === 'DECLINED') {
        return { status: 200, body: { requestId, decision: 'DECLINED' } };
      }
      if (upstream.status === 409) return { status: 409, body: { error: 'NOT_PENDING' } };
      return failure(upstream.status) ?? MISMATCH;
    }

    if (body['grounds'] !== undefined) throw new HttpError(400, 'INVALID_REQUEST', 'Field "grounds" belongs to DECLINE only.');
    // Resolve the applicant from the pending queue (the queue is the authority on "pending").
    const queue = await deps.upstream.call({
      operation: UPSTREAM.erasureQueue, correlationId: ctx.correlationId, credential: session.upstreamCredential,
    });
    if (queue.status !== 200) return failure(queue.status) ?? MISMATCH;
    const requests = (queue.body as { requests?: unknown } | null)?.requests;
    if (!Array.isArray(requests)) return MISMATCH;
    const match = requests.find((r): r is { requestId: string; applicantId: string } =>
      r !== null && typeof r === 'object' && (r as Record<string, unknown>)['requestId'] === requestId &&
      typeof (r as Record<string, unknown>)['applicantId'] === 'string');
    // Not pending (decided already) or unknown: one answer, no existence signal.
    if (match === undefined) return { status: 404, body: { error: 'NOT_FOUND' } };

    const executed = await deps.upstream.call({
      operation: UPSTREAM.erasureExecute, correlationId: ctx.correlationId, credential: session.upstreamCredential,
      body: { applicantId: match.applicantId },
    });
    const status = statusOf(executed.body);
    if (executed.status === 200 && (status === 'ERASED' || status === 'ALREADY_ERASED')) {
      return { status: 200, body: { requestId, decision: 'EXECUTED' } };
    }
    if (executed.status === 409 && status === 'REFUSED_ACTIVE_APPLICATION') {
      return { status: 409, body: { error: 'REFUSED_ACTIVE_APPLICATION' } };
    }
    if (executed.status === 409 && status === 'REFUSED_ACCEPT_LOCKED') {
      return { status: 409, body: { error: 'REFUSED_ACCEPT_LOCKED' } };
    }
    return failure(executed.status) ?? MISMATCH;
  });
}
