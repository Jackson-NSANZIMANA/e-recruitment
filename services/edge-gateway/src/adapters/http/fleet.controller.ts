// ══════════════════════════════════════════════════════════════════
// edge-gateway — Device fleet and venue live counts (S09)
//
//   GET  /edge/v1/field-sync/devices          field.device.manage   listFieldDevices
//   POST /edge/v1/field-sync/devices/assign   field.device.manage   assignDeviceToVenueDay
//   POST /edge/v1/field-sync/devices/revoke   field.device.manage   revokeFieldDevice
//   GET  /edge/v1/gate/live-counts            field.score.sync | field.device.manage   getVenueLiveCounts
//
// The agency is the session's: no body or query key can carry one (an unknown
// key is a 400). A revocation requires a CLOSED reason code, is CSRF-protected
// and never retried. A device of another agency and one that does not exist
// are the same bare 404.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type RouteHandler } from '@usrp/shared-http';
import { UPSTREAM } from '../../domain/upstream-operations.js';
import { withOfficerSession, type EdgeDeps } from './guards.js';
import { FORBIDDEN, NOT_FOUND } from './outcomes.js';
import { projectFleetDevices, projectVenueLiveCounts } from './operational-projections.js';
import { readJsonBody, requireBoundedString } from './validation.js';

const MISMATCH: HttpResult = { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
const UNAVAILABLE: HttpResult = { status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } };
const BAD: HttpResult = { status: 400, body: { error: 'INVALID_REQUEST' } };
const SESSION_ENDED: HttpResult = { status: 401, body: { reason: 'revoked' } };

const MAX_DEVICE_ID = 64;
const REVOKE_REASONS: ReadonlySet<string> = new Set(['LOST', 'STOLEN', 'COMPROMISED', 'RETIRED', 'OTHER']);
const PUBLIC_CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,63}$/;
const DISTRICT_RE = /^[A-Z][A-Z_]{1,29}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new HttpError(400, 'INVALID_REQUEST', `Field "${key}" is not accepted.`);
  }
}

function failure(status: number): HttpResult | null {
  if (status === 400) return BAD;
  if (status === 401) return SESSION_ENDED;
  if (status === 403) return FORBIDDEN;
  if (status === 404) return NOT_FOUND;
  if (status === 503) return UNAVAILABLE;
  return null;
}

export function listFieldDevicesHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'listFieldDevices', async (ctx, session) => {
    if (ctx.query.toString().length !== 0) throw new HttpError(400, 'INVALID_REQUEST');
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.fleetList, correlationId: ctx.correlationId, credential: session.upstreamCredential,
    });
    if (upstream.status === 200) {
      const body = projectFleetDevices(upstream.body);
      return body === null ? MISMATCH : { status: 200, body };
    }
    return failure(upstream.status) ?? MISMATCH;
  });
}

export function assignDeviceToVenueDayHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'assignDeviceToVenueDay', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    onlyKeys(body, ['deviceId', 'campaign', 'district', 'examDate']);
    const deviceId = requireBoundedString(body['deviceId'], 'deviceId', MAX_DEVICE_ID);
    const campaign = requireBoundedString(body['campaign'], 'campaign', 64).toUpperCase();
    const district = requireBoundedString(body['district'], 'district', 30).toUpperCase();
    const examDate = requireBoundedString(body['examDate'], 'examDate', 10);
    if (!PUBLIC_CODE_RE.test(campaign) || !DISTRICT_RE.test(district) || !DAY_RE.test(examDate)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'campaign, district or examDate is malformed.');
    }
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.fleetAssign, correlationId: ctx.correlationId, credential: session.upstreamCredential,
      body: { deviceId, campaign, district, examDate },
    });
    if (upstream.status === 200) return { status: 200, body: { status: 'ASSIGNED', deviceId, campaign, district, examDate } };
    if (upstream.status === 409) return { status: 409, body: { error: 'DEVICE_REVOKED' } };
    return failure(upstream.status) ?? MISMATCH;
  });
}

export function revokeFieldDeviceHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'revokeFieldDevice', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    onlyKeys(body, ['deviceId', 'reason']);
    const deviceId = requireBoundedString(body['deviceId'], 'deviceId', MAX_DEVICE_ID);
    const reason = requireBoundedString(body['reason'], 'reason', 24);
    if (!REVOKE_REASONS.has(reason)) throw new HttpError(400, 'INVALID_REQUEST', '"reason" is not an accepted reason code.');
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.fleetRevoke, correlationId: ctx.correlationId, credential: session.upstreamCredential,
      body: { deviceId, reason },
    });
    if (upstream.status === 200) {
      const status = upstream.body !== null && typeof upstream.body === 'object'
        ? (upstream.body as Record<string, unknown>)['status'] : undefined;
      return { status: 200, body: { status: status === 'ALREADY_REVOKED' ? 'ALREADY_REVOKED' : 'REVOKED', deviceId } };
    }
    return failure(upstream.status) ?? MISMATCH;
  });
}

export function getVenueLiveCountsHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'getVenueLiveCounts', async (ctx, session) => {
    const query: Record<string, string> = {};
    for (const key of new Set(ctx.query.keys())) {
      if (!['campaign', 'district', 'examDate'].includes(key)) throw new HttpError(400, 'INVALID_REQUEST', `Query "${key}" is not accepted.`);
      const values = ctx.query.getAll(key);
      if (values.length !== 1) throw new HttpError(400, 'INVALID_REQUEST', `Query "${key}" may be given once.`);
      const raw = (values[0] ?? '').trim();
      const value = key === 'examDate' ? raw : raw.toUpperCase();
      const ok = key === 'campaign' ? PUBLIC_CODE_RE.test(value) : key === 'district' ? DISTRICT_RE.test(value) : DAY_RE.test(value);
      if (!ok) throw new HttpError(400, 'INVALID_REQUEST', `Query "${key}" is invalid.`);
      query[key] = value;
    }
    if (query['campaign'] === undefined || query['district'] === undefined || query['examDate'] === undefined) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Queries "campaign", "district" and "examDate" are required.');
    }
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.venueLiveCounts, correlationId: ctx.correlationId, credential: session.upstreamCredential, query,
    });
    if (upstream.status === 200) {
      const body = projectVenueLiveCounts(upstream.body);
      return body === null ? MISMATCH : { status: 200, body };
    }
    return failure(upstream.status) ?? MISMATCH;
  });
}
