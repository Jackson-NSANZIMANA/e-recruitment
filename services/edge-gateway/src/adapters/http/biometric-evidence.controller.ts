// ══════════════════════════════════════════════════════════════════
// edge-gateway — Biometric identity evidence (ADR-037)
//
//   GET  /edge/v1/gate/biometric-policy               officer  biometric.verify
//   POST /edge/v1/gate/biometric-evidence             officer  biometric.verify   (CSRF, ≤ 4 KiB)
//   GET  /edge/v1/applications/biometric-evidence     officer  biometric.evidence.read
//   POST /edge/v1/gate/manual-identity                officer  identity.manual.confirm (CSRF)
//
// NO IMAGE CROSSES THIS TIER. Before anything is forwarded, the evidence body
// must be exactly { record, signature }; the record must be FLAT (no object,
// no array), at most 24 keys, every value a string of ≤ 128 characters, an
// integer, or null; no value may be a data: URI. The 4 KiB body cap is applied
// by the route itself. biometric-service re-validates the exact schema.
//
// Writes are never retried here. Every answer is rebuilt from a closed
// allowlist: the evidence read carries scores, outcome, method and the
// supervisor's reason — never a device id, key id, signature or officer id.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type RouteHandler } from '@usrp/shared-http';
import { UPSTREAM } from '../../domain/upstream-operations.js';
import { NOT_FOUND } from './outcomes.js';
import { withOfficerSession, type EdgeDeps } from './guards.js';
import { isRecord, readJsonBody, requireApplicationIdQuery, requireUuid } from './validation.js';

const MISMATCH: HttpResult = { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TOKEN_RE = /^[A-Za-z0-9._:+-]{1,64}$/;
const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;
const MAX_RECORD_KEYS = 24;
const MAX_RECORD_STRING = 128;

const MODES = new Set(['SHADOW', 'ADVISORY']);
const POLICY_MODES = new Set(['OFF', 'SHADOW', 'ADVISORY']);
const OUTCOMES = new Set(['MATCH', 'NO_MATCH', 'INCONCLUSIVE', 'NOT_ATTEMPTED']);
const SOURCES = new Set(['CARD_PORTRAIT', 'NIDA_PORTRAIT', 'NONE']);
const SOURCE_STATUSES = new Set(['DEVICE_ATTESTED', 'SERVER_MATCH', 'NOT_AUTHORISED', 'MANUAL_ONLY']);
const METHODS = new Set(['FACE_1_1_ON_DEVICE', 'NONE']);
const CONSENT = new Set(['GIVEN', 'DECLINED', 'NOT_REQUIRED_BY_POLICY']);
const NOT_ATTEMPTED = new Set(['CANDIDATE_DECLINED', 'CAPTURE_FAILED', 'CARD_PORTRAIT_UNREADABLE', 'DEVICE_UNAVAILABLE', 'NO_REFERENCE_SOURCE']);
const MANUAL_REASONS = new Set([
  'CARD_PHOTO_OUTDATED', 'APPEARANCE_CHANGED', 'POOR_CAPTURE_CONDITIONS',
  'CARD_PORTRAIT_DAMAGED', 'SECONDARY_DOCUMENT_CHECKED', 'SUPERVISOR_INTERVIEW',
]);
const INVALID_REASONS = new Set([
  'IMAGE_PAYLOAD_REFUSED', 'SCHEMA_INVALID', 'THRESHOLD_POLICY_UNKNOWN', 'THRESHOLD_POLICY_NOT_IN_FORCE',
  'OUTCOME_INCONSISTENT', 'CONSENT_STATE_NOT_PERMITTED', 'CAPTURED_AT_OUT_OF_RANGE',
  'REFERENCE_SOURCE_NOT_AUTHORISED', 'UNKNOWN_TICKET',
]);
const TRUST_REASONS = new Set(['UNKNOWN_DEVICE', 'DEVICE_WRONG_AGENCY', 'DEVICE_REVOKED', 'KEY_MISMATCH', 'SIGNATURE_INVALID']);

const IMAGE_REFUSED: HttpResult = { status: 422, body: { error: 'INVALID_EVIDENCE', reason: 'IMAGE_PAYLOAD_REFUSED' } };
const SCHEMA_REFUSED: HttpResult = { status: 422, body: { error: 'INVALID_EVIDENCE', reason: 'SCHEMA_INVALID' } };

function instant(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
}

function nullableInt(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000);
}

function nullableToken(v: unknown): v is string | null {
  return v === null || (typeof v === 'string' && TOKEN_RE.test(v));
}

/**
 * The edge's structural image guard. Returns the refusal, or null when the
 * body is a flat, small, scalar-only { record, signature } pair.
 */
export function screenEvidenceBody(body: Record<string, unknown>): HttpResult | null {
  // Anything image-shaped is named as such, under any key.
  for (const value of Object.values(body)) {
    if (Array.isArray(value)) return IMAGE_REFUSED;
    if (typeof value === 'string' && (value.length > 1_024 || /^\s*data:/i.test(value))) return IMAGE_REFUSED;
  }
  const record = body['record'];
  if (isRecord(record)) {
    for (const value of Object.values(record)) {
      if (Array.isArray(value) || isRecord(value)) return IMAGE_REFUSED;
      if (typeof value === 'string' && (value.length > MAX_RECORD_STRING || /^\s*data:/i.test(value))) return IMAGE_REFUSED;
    }
  }
  const keys = Object.keys(body);
  if (keys.length !== 2 || !isRecord(record) || typeof body['signature'] !== 'string' || !SIGNATURE_RE.test(body['signature'])) {
    return SCHEMA_REFUSED;
  }
  const entries = Object.entries(record);
  if (entries.length > MAX_RECORD_KEYS) return SCHEMA_REFUSED;
  for (const [, value] of entries) {
    if (!(value === null || typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value)))) return SCHEMA_REFUSED;
  }
  return null;
}

/** The allowlisted record answer, or null when off-contract. */
export function projectRecordEvidence(status: number, raw: unknown): HttpResult | null {
  if (!isRecord(raw)) return null;
  if (status === 201) {
    if (raw['status'] !== 'RECORDED' || typeof raw['recordId'] !== 'string' || !UUID_RE.test(raw['recordId'])
        || typeof raw['mode'] !== 'string' || !MODES.has(raw['mode']) || !instant(raw['receivedAt'])) return null;
    const body: Record<string, unknown> = { status: 'RECORDED', recordId: raw['recordId'], mode: raw['mode'], receivedAt: raw['receivedAt'] };
    // A SHADOW outcome is never shown: drop it even if an upstream sent one.
    if (raw['mode'] === 'ADVISORY') {
      if (typeof raw['outcome'] !== 'string' || !OUTCOMES.has(raw['outcome'])) return null;
      body['outcome'] = raw['outcome'];
    }
    return { status: 201, body };
  }
  if (status === 200) {
    if (raw['status'] !== 'ALREADY_RECORDED' || typeof raw['recordId'] !== 'string' || !UUID_RE.test(raw['recordId'])
        || typeof raw['mode'] !== 'string' || !MODES.has(raw['mode'])) return null;
    return { status: 200, body: { status: 'ALREADY_RECORDED', recordId: raw['recordId'], mode: raw['mode'] } };
  }
  if (status === 409) {
    if (raw['error'] === 'REPLAY_CONFLICT' || raw['error'] === 'BIOMETRIC_OFF') return { status: 409, body: { error: raw['error'] } };
    if (raw['error'] === 'MODE_MISMATCH' && typeof raw['configuredMode'] === 'string' && MODES.has(raw['configuredMode'])) {
      return { status: 409, body: { error: 'MODE_MISMATCH', configuredMode: raw['configuredMode'] } };
    }
    return null;
  }
  if (status === 422) {
    return raw['error'] === 'INVALID_EVIDENCE' && typeof raw['reason'] === 'string' && INVALID_REASONS.has(raw['reason'])
      ? { status: 422, body: { error: 'INVALID_EVIDENCE', reason: raw['reason'] } }
      : null;
  }
  if (status === 403) {
    if (raw['error'] === 'UNTRUSTED_EVIDENCE' && typeof raw['reason'] === 'string' && TRUST_REASONS.has(raw['reason'])) {
      return { status: 403, body: { error: 'UNTRUSTED_EVIDENCE', reason: raw['reason'] } };
    }
    return { status: 403, body: { error: 'PERMISSION_DENIED' } };
  }
  return null;
}

/** The allowlisted policy, or null. */
export function projectBiometricPolicy(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  const tp = raw['thresholdPolicy'];
  const sources = raw['referenceSources'];
  if (typeof raw['agency'] !== 'string' || !CODE_RE.test(raw['agency'])) return null;
  if (typeof raw['mode'] !== 'string' || !POLICY_MODES.has(raw['mode'])) return null;
  if (typeof raw['legalBasis'] !== 'string' || !CODE_RE.test(raw['legalBasis'])) return null;
  if (raw['evidenceSchema'] !== 'USRP-BIO-EVIDENCE.v1' || typeof raw['maxBodyBytes'] !== 'number') return null;
  if (!isRecord(tp) || typeof tp['version'] !== 'string' || !TOKEN_RE.test(tp['version'])
      || !nullableInt(tp['livenessPassBp']) || !nullableInt(tp['matchBp']) || !nullableInt(tp['noMatchBelowBp'])
      || tp['livenessPassBp'] === null || tp['matchBp'] === null || tp['noMatchBelowBp'] === null) return null;
  if (!Array.isArray(sources)) return null;
  const projectedSources: Record<string, unknown>[] = [];
  for (const s of sources) {
    if (!isRecord(s) || typeof s['id'] !== 'string' || !SOURCES.has(s['id'])
        || typeof s['status'] !== 'string' || !SOURCE_STATUSES.has(s['status'])) return null;
    projectedSources.push({ id: s['id'], status: s['status'] });
  }
  return {
    agency: raw['agency'],
    mode: raw['mode'],
    legalBasis: raw['legalBasis'],
    evidenceSchema: raw['evidenceSchema'],
    maxBodyBytes: raw['maxBodyBytes'],
    thresholdPolicy: {
      version: tp['version'],
      livenessPassBp: tp['livenessPassBp'],
      matchBp: tp['matchBp'],
      noMatchBelowBp: tp['noMatchBelowBp'],
    },
    referenceSources: projectedSources,
  };
}

function projectEvidenceItem(v: unknown): Record<string, unknown> | null {
  if (!isRecord(v)) return null;
  const m = v['manualIdentity'];
  if (typeof v['recordId'] !== 'string' || !UUID_RE.test(v['recordId'])) return null;
  if (typeof v['ticketId'] !== 'string' || !TOKEN_RE.test(v['ticketId'])) return null;
  if (typeof v['referenceSource'] !== 'string' || !SOURCES.has(v['referenceSource'])) return null;
  if (typeof v['method'] !== 'string' || !METHODS.has(v['method'])) return null;
  if (typeof v['consentState'] !== 'string' || !CONSENT.has(v['consentState'])) return null;
  if (typeof v['outcome'] !== 'string' || !OUTCOMES.has(v['outcome'])) return null;
  if (v['notAttemptedReason'] !== null && (typeof v['notAttemptedReason'] !== 'string' || !NOT_ATTEMPTED.has(v['notAttemptedReason']))) return null;
  if (!nullableInt(v['livenessScoreBp']) || !nullableInt(v['matchScoreBp'])) return null;
  if (!nullableToken(v['modelId']) || !nullableToken(v['modelVersion'])) return null;
  if (typeof v['thresholdPolicyVersion'] !== 'string' || !TOKEN_RE.test(v['thresholdPolicyVersion'])) return null;
  // Only ADVISORY evidence may ever be shown to an officer.
  if (v['mode'] !== 'ADVISORY') return null;
  if (!instant(v['capturedAt']) || !instant(v['receivedAt'])) return null;
  let manualIdentity: Record<string, unknown> | null = null;
  if (m !== null) {
    if (!isRecord(m) || typeof m['reasonCode'] !== 'string' || !MANUAL_REASONS.has(m['reasonCode']) || !instant(m['confirmedAt'])) return null;
    manualIdentity = { reasonCode: m['reasonCode'], confirmedAt: m['confirmedAt'] };
  }
  return {
    recordId: v['recordId'],
    ticketId: v['ticketId'],
    referenceSource: v['referenceSource'],
    method: v['method'],
    consentState: v['consentState'],
    outcome: v['outcome'],
    notAttemptedReason: v['notAttemptedReason'],
    livenessScoreBp: v['livenessScoreBp'],
    matchScoreBp: v['matchScoreBp'],
    modelId: v['modelId'],
    modelVersion: v['modelVersion'],
    thresholdPolicyVersion: v['thresholdPolicyVersion'],
    mode: 'ADVISORY',
    capturedAt: v['capturedAt'],
    receivedAt: v['receivedAt'],
    manualIdentity,
  };
}

/** The allowlisted evidence list, or null. */
export function projectEvidenceList(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw) || typeof raw['applicationId'] !== 'string' || !UUID_RE.test(raw['applicationId'])) return null;
  const list = raw['evidence'];
  if (!Array.isArray(list) || list.length > 50) return null;
  const evidence: Record<string, unknown>[] = [];
  for (const item of list) {
    const p = projectEvidenceItem(item);
    if (p === null) return null;
    evidence.push(p);
  }
  return { applicationId: raw['applicationId'], evidence };
}

export function getBiometricPolicyHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'getBiometricPolicy', async (ctx, session) => {
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.biometricPolicy,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
    });
    if (upstream.status === 403) return { status: 403, body: { error: 'PERMISSION_DENIED' } };
    if (upstream.status !== 200) return MISMATCH;
    const policy = projectBiometricPolicy(upstream.body);
    return policy === null ? MISMATCH : { status: 200, body: policy };
  });
}

export function recordBiometricEvidenceHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'recordBiometricEvidence', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    const refused = screenEvidenceBody(body);
    if (refused !== null) return refused;
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.biometricEvidenceRecord,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { record: body['record'], signature: body['signature'] },
    });
    if (upstream.status === 400) return { status: 400, body: { error: 'INVALID_REQUEST' } };
    if (upstream.status === 503) return { status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } };
    return projectRecordEvidence(upstream.status, upstream.body) ?? MISMATCH;
  });
}

export function getBiometricEvidenceHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'getBiometricEvidence', async (ctx, session) => {
    const applicationId = requireApplicationIdQuery(ctx).toLowerCase();
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.biometricEvidenceRead,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      query: { applicationId },
    });
    if (upstream.status === 404) return NOT_FOUND;
    if (upstream.status === 403) return { status: 403, body: { error: 'PERMISSION_DENIED' } };
    if (upstream.status !== 200) return MISMATCH;
    const list = projectEvidenceList(upstream.body);
    return list === null ? MISMATCH : { status: 200, body: list };
  });
}

export function confirmManualIdentityHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'confirmManualIdentity', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    const recordId = requireUuid(body['recordId'], 'recordId');
    const reasonCode = body['reasonCode'];
    if (typeof reasonCode !== 'string' || !MANUAL_REASONS.has(reasonCode)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Field "reasonCode" must be a manual-identity reason code.');
    }
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.manualIdentityConfirm,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { recordId: recordId.toLowerCase(), reasonCode },
    });
    const b = isRecord(upstream.body) ? upstream.body : {};
    if (upstream.status === 201) {
      if (b['status'] !== 'CONFIRMED' || typeof b['confirmationId'] !== 'string' || !UUID_RE.test(b['confirmationId'])
          || typeof b['recordId'] !== 'string' || !UUID_RE.test(b['recordId']) || !instant(b['confirmedAt'])) return MISMATCH;
      return { status: 201, body: { status: 'CONFIRMED', confirmationId: b['confirmationId'], recordId: b['recordId'], confirmedAt: b['confirmedAt'] } };
    }
    if (upstream.status === 404) return NOT_FOUND;
    if (upstream.status === 403) return { status: 403, body: { error: 'PERMISSION_DENIED' } };
    if (upstream.status === 400) return { status: 400, body: { error: 'INVALID_REQUEST' } };
    if (upstream.status === 409 && typeof b['error'] === 'string'
        && ['NOT_REQUIRED', 'ALREADY_CONFIRMED', 'SAME_OFFICER'].includes(b['error'])) {
      return { status: 409, body: { error: b['error'] } };
    }
    return MISMATCH;
  });
}
