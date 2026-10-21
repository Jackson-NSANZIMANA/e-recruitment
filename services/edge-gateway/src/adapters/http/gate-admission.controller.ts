// ══════════════════════════════════════════════════════════════════
// edge-gateway — Single-use admission at the venue gate (BUILD-003, ADR-034)
//
//   POST /edge/v1/gate/admissions        officer  admission.gate  (CSRF)
//     { qrToken, nationalId, gateVenueName }
//
// → identity-service POST /v1/gate/admissions under the officer's credential.
// identity-service hashes the card number (it alone holds the key) and
// application-service decides. This tier validates shape, never retries (a
// replayed admission would be answered ALREADY_ADMITTED and confuse the gate),
// and REBUILDS the answer from a closed allowlist: the candidate's public
// identifiers and the outcome detail, nothing else.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type RouteHandler } from '@usrp/shared-http';
import { UPSTREAM } from '../../domain/upstream-operations.js';
import { withOfficerSession, type EdgeDeps } from './guards.js';
import { readJsonBody, requireBoundedString, requireNationalId } from './validation.js';

const MAX_TICKET_LENGTH = 4096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CONFLICTS = new Set(['ALREADY_ADMITTED', 'NOT_ADMISSIBLE', 'IDENTITY_MISMATCH', 'MANUAL_IDENTITY_REQUIRED', 'WRONG_VENUE', 'TOO_EARLY', 'EXPIRED']);
/** ADR-037: the identity method an admission recorded. */
const IDENTITY_METHODS = new Set(['NATIONAL_ID_CARD', 'NATIONAL_ID_CARD+CARD_PORTRAIT', 'NATIONAL_ID_CARD+SUPERVISOR']);
const INVALID_REASONS = new Set(['MALFORMED_TICKET', 'WRONG_AGENCY', 'UNKNOWN_TICKET', 'TICKET_NOT_ISSUED']);
const MISMATCH: HttpResult = { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };

function text(v: unknown, max = 200): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function instant(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function candidate(v: unknown): Record<string, unknown> | null {
  if (v === null || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (typeof c['applicationId'] !== 'string' || !UUID_RE.test(c['applicationId'])) return null;
  if (!text(c['processingCode'], 32) || typeof c['category'] !== 'string' || !CODE_RE.test(c['category'])) return null;
  return { applicationId: c['applicationId'], processingCode: c['processingCode'], category: c['category'] };
}

/** The allowlisted gate result, or null when the upstream is off-contract. */
export function projectGateAdmission(status: number, raw: unknown): HttpResult | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (status === 200) {
    const cand = candidate(b['candidate']);
    if (
      b['outcome'] !== 'ADMITTED' || cand === null || !text(b['venueName']) ||
      typeof b['examDate'] !== 'string' || !DATE_RE.test(b['examDate']) ||
      typeof b['reportingTimeHour'] !== 'number' || !instant(b['admittedAt']) ||
      typeof b['statusAdvanced'] !== 'boolean' ||
      typeof b['identityMethod'] !== 'string' || !IDENTITY_METHODS.has(b['identityMethod'])
    ) {
      return null;
    }
    return {
      status: 200,
      body: {
        outcome: 'ADMITTED',
        candidate: cand,
        venueName: b['venueName'],
        examDate: b['examDate'],
        reportingTimeHour: b['reportingTimeHour'],
        admittedAt: b['admittedAt'],
        statusAdvanced: b['statusAdvanced'],
        identityMethod: b['identityMethod'],
      },
    };
  }
  if (status === 409) {
    const error = b['error'];
    if (typeof error !== 'string' || !CONFLICTS.has(error)) return null;
    if (error === 'ALREADY_ADMITTED') {
      const cand = candidate(b['candidate']);
      if (cand === null || !instant(b['admittedAt']) || !text(b['venueName']) || typeof b['admittedBySelf'] !== 'boolean') return null;
      return { status: 409, body: { error, candidate: cand, admittedAt: b['admittedAt'], venueName: b['venueName'], admittedBySelf: b['admittedBySelf'] } };
    }
    if (error === 'NOT_ADMISSIBLE') {
      const cand = candidate(b['candidate']);
      if (cand === null || typeof b['currentStatus'] !== 'string' || !CODE_RE.test(b['currentStatus'])) return null;
      return { status: 409, body: { error, candidate: cand, currentStatus: b['currentStatus'] } };
    }
    if (error === 'IDENTITY_MISMATCH' || error === 'MANUAL_IDENTITY_REQUIRED') {
      const cand = candidate(b['candidate']);
      return cand === null ? null : { status: 409, body: { error, candidate: cand } };
    }
    if (error === 'WRONG_VENUE') {
      return text(b['ticketVenueName']) ? { status: 409, body: { error, ticketVenueName: b['ticketVenueName'] } } : null;
    }
    // TOO_EARLY | EXPIRED
    return typeof b['examDate'] === 'string' && DATE_RE.test(b['examDate'])
      ? { status: 409, body: { error, examDate: b['examDate'] } }
      : null;
  }
  if (status === 422) {
    if (b['error'] !== 'INVALID_TICKET' || typeof b['reason'] !== 'string' || !INVALID_REASONS.has(b['reason'])) return null;
    return { status: 422, body: { error: 'INVALID_TICKET', reason: b['reason'] } };
  }
  return null;
}

export function admitAtGateHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'admitAtGate', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    const qrToken = typeof body.qrToken === 'string' ? body.qrToken.trim() : '';
    if (qrToken.length === 0 || qrToken.length > MAX_TICKET_LENGTH) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Field "qrToken" is required.');
    }
    const nationalId = requireNationalId(body.nationalId);
    const gateVenueName = requireBoundedString(
      typeof body.gateVenueName === 'string' ? body.gateVenueName.trim() : body.gateVenueName,
      'gateVenueName',
      200,
    );

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.admitAtGate,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { qrToken, nationalId, gateVenueName },
    });

    if (upstream.status === 400) return { status: 400, body: { error: 'INVALID_REQUEST' } };
    if (upstream.status === 403) return { status: 403, body: { error: 'PERMISSION_DENIED' } };
    if (upstream.status === 503) return { status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } };
    return projectGateAdmission(upstream.status, upstream.body) ?? MISMATCH;
  });
}
