// ══════════════════════════════════════════════════════════════════
// edge-gateway — Advisory document checklist + venue verification (ADR-032)
//
//   GET  /edge/v1/me/applications/document-checklist?applicationId=   applicant
//   GET  /edge/v1/applications/document-checklist?applicationId=      officer  application.read
//   POST /edge/v1/applications/documents/verify-at-venue              officer  document.verify.venue
//
// The checklist is REBUILT from an allowlist on the way out: agency, source,
// complete, and per item { documentType, satisfaction, registry }. Anything
// else an upstream ever adds is dropped here, so a future scores-or-officer
// field cannot leak to a citizen by accident.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type RouteHandler } from '@usrp/shared-http';
import { UPSTREAM } from '../../domain/upstream-operations.js';
import { NOT_FOUND } from './outcomes.js';
import { withApplicantSession, withOfficerSession, type EdgeDeps } from './guards.js';
import { readJsonBody, requireApplicationIdQuery, requireUuid } from './validation.js';

const DOCUMENT_TYPE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const SATISFACTIONS = new Set([
  'API_VERIFIED',
  'UPLOADED_CLEARED',
  'VENUE_VERIFIED',
  'AWAITING_REGISTRY',
  'UNDER_REVIEW',
  'REJECTED',
  'MISSING',
]);
const REGISTRIES = new Set(['NIDA', 'NESA', 'HEC', 'RIB']);

/** The allowlisted checklist, or null when the upstream shape is wrong. */
export function projectChecklist(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const items = v['items'];
  if (typeof v['agency'] !== 'string' || typeof v['source'] !== 'string' || typeof v['complete'] !== 'boolean' || !Array.isArray(items)) {
    return null;
  }
  const projected: Record<string, unknown>[] = [];
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') return null;
    const i = raw as Record<string, unknown>;
    const documentType = i['documentType'];
    const satisfaction = i['satisfaction'];
    const registry = i['registry'];
    if (typeof documentType !== 'string' || !DOCUMENT_TYPE_RE.test(documentType)) return null;
    if (typeof satisfaction !== 'string' || !SATISFACTIONS.has(satisfaction)) return null;
    if (registry !== null && (typeof registry !== 'string' || !REGISTRIES.has(registry))) return null;
    projected.push({ documentType, satisfaction, registry });
  }
  return { agency: v['agency'], source: v['source'], complete: v['complete'], items: projected };
}

const MISMATCH: HttpResult = { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };

export function getMyDocumentChecklistHandler(deps: EdgeDeps): RouteHandler {
  return withApplicantSession(deps, 'getMyDocumentChecklist', async (ctx, session) => {
    const applicationId = requireApplicationIdQuery(ctx);
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.myDocumentChecklist,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      query: { applicationId },
    });
    if (upstream.status === 401) return { status: 401, body: { reason: 'revoked' } };
    if (upstream.status === 404) return NOT_FOUND;
    if (upstream.status !== 200) return MISMATCH;
    const checklist = projectChecklist(upstream.body);
    return checklist === null ? MISMATCH : { status: 200, body: checklist };
  });
}

export function getDocumentChecklistHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'getDocumentChecklist', async (ctx, session) => {
    const applicationId = requireApplicationIdQuery(ctx);
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.documentChecklist,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      query: { applicationId },
    });
    // Byte-identical for nonexistent and a sibling agency's id.
    if (upstream.status === 404) return NOT_FOUND;
    if (upstream.status !== 200) return MISMATCH;
    const checklist = projectChecklist(upstream.body);
    return checklist === null ? MISMATCH : { status: 200, body: checklist };
  });
}

export function verifyDocumentAtVenueHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'verifyDocumentAtVenue', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    const applicationId = requireUuid(body.applicationId, 'applicationId');
    const documentType = body.documentType;
    if (typeof documentType !== 'string' || !DOCUMENT_TYPE_RE.test(documentType)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Field "documentType" is required.');
    }
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.verifyDocumentAtVenue,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { applicationId, documentType },
    });
    if (upstream.status === 200) {
      const b = (upstream.body ?? {}) as Record<string, unknown>;
      const status = b['status'];
      const checklist = projectChecklist(b['checklist']);
      if ((status !== 'RECORDED' && status !== 'ALREADY_RECORDED') || checklist === null) return MISMATCH;
      return { status: 200, body: { status, checklist } };
    }
    if (upstream.status === 404) return NOT_FOUND;
    if (upstream.status === 403) return { status: 403, body: { error: 'PERMISSION_DENIED' } };
    if (upstream.status === 409) return { status: 409, body: { error: 'NOT_APPLICABLE' } };
    if (upstream.status === 422) return { status: 422, body: { error: 'NOT_REQUIRED' } };
    if (upstream.status === 400) return { status: 400, body: { error: 'INVALID_REQUEST' } };
    return MISMATCH;
  });
}
