// ══════════════════════════════════════════════════════════════════
// edge-gateway — Field sync (the NEW browser surface)
//
// THE DECISION: BROKER, NOT EXCLUDE.
//
// The three upstream controllers were implemented and had no browser route,
// which is why the frontend keeps OFFLINE_CAPTURE_CAN_SYNC = false and tells the
// tablet UI, honestly, that captured scores remain on-device. Excluding them
// permanently would mean an exam-day tablet can capture physical-test scores and
// never deliver them — the offline lane's entire purpose. So they are brokered:
// officer session, agency from the session, CSRF enforced, batch bounded, and
// nothing retried automatically.
//
// THE RECORDS ARE FORWARDED FIELD-FOR-FIELD, DELIBERATELY. Each record carries a
// device Ed25519 signature over a canonical payload. Normalising a value,
// re-ordering a key or dropping an unknown field would invalidate that
// signature, and the signature is the real integrity gate — the edge's shape
// check is only the cheap first pass. So the edge validates types and rebuilds
// the record with the SAME values, and never rewrites one.
//
// A FORGED RECORD IS NOT AN ERROR. Malformed shape is a 400 for the whole batch;
// a well-formed but forged record is REJECTED per-record inside a 200, so a safe
// re-upload converges instead of the tablet losing the honest records alongside
// the bad one.
//
// NO AUTOMATIC RETRY. A re-uploaded batch converges because the upstream reports
// per-record outcomes, not because anything here retries. A retried score sync
// is a duplicated exam result on a citizen's record.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type RouteHandler } from '@usrp/shared-http';
import { UPSTREAM } from '../../registry/upstream-operations.js';
import { field } from './projections.js';
import { FORBIDDEN, NOT_FOUND, conflictResult } from './outcomes.js';
import { withOfficerSession, type EdgeDeps } from './guards.js';
import { assertNoLeakedFields } from './leak-guard.js';
import { isRecord, readJsonBody, requireBoundedString, requireOneOf, requireUuid } from './validation.js';

const MAX_DEVICE_ID = 64;
const MAX_PUBLIC_KEY_PEM = 4_096;
const MAX_RESOLUTION = 50;
/**
 * Bytes alone do not bound the work: each record costs an Ed25519 verification
 * and a database round trip upstream, so the COUNT is capped too. 200 is a
 * generous day at one exam venue and far below what would make one request able
 * to monopolise the service.
 */
const MAX_RECORDS = 200;
const MAX_SIGNATURE = 512;
const MAX_HASH = 128;
const MAX_CLOCK_ENTRIES = 64;
const FITNESS: ReadonlySet<string> = new Set(['FIT', 'UNFIT', 'PENDING_REVIEW']);

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(400, 'INVALID_RECORD', `"${path}" must be a finite number.`);
  }
  return value;
}

function requireRecordObject(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new HttpError(400, 'INVALID_RECORD', `"${path}" must be an object.`);
  }
  return value;
}

/** Metrics, rebuilt with identical values so the device signature still verifies. */
function metricsOf(value: unknown): Record<string, unknown> {
  const m = requireRecordObject(value, 'metrics');
  const notes = m.additionalNotes;
  if (notes !== undefined && typeof notes !== 'string') {
    throw new HttpError(400, 'INVALID_RECORD', '"metrics.additionalNotes" must be a string.');
  }
  return {
    heightCm: requireNumber(m.heightCm, 'metrics.heightCm'),
    weightKg: requireNumber(m.weightKg, 'metrics.weightKg'),
    run3kmTimeSeconds: requireNumber(m.run3kmTimeSeconds, 'metrics.run3kmTimeSeconds'),
    chestCm: requireNumber(m.chestCm, 'metrics.chestCm'),
    medicalFitnessStatus: requireOneOf(
      m.medicalFitnessStatus,
      'metrics.medicalFitnessStatus',
      FITNESS,
    ),
    ...(notes === undefined ? {} : { additionalNotes: notes }),
  };
}

function vectorClockOf(value: unknown): Record<string, number> {
  const raw = requireRecordObject(value, 'vectorClock');
  const entries = Object.entries(raw);
  if (entries.length > MAX_CLOCK_ENTRIES) {
    throw new HttpError(400, 'INVALID_RECORD', '"vectorClock" has too many entries.');
  }
  const clock: Record<string, number> = {};
  for (const [device, count] of entries) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      throw new HttpError(400, 'INVALID_RECORD', '"vectorClock" values must be non-negative integers.');
    }
    clock[device] = count;
  }
  return clock;
}

function scoreRecordOf(value: unknown, index: number): Record<string, unknown> {
  const r = requireRecordObject(value, `records[${index}]`);
  return {
    applicationId: requireUuid(r.applicationId, `records[${index}].applicationId`),
    qrInvitationCode: requireBoundedString(r.qrInvitationCode, 'qrInvitationCode', MAX_HASH * 4),
    metrics: metricsOf(r.metrics),
    capturedAt: requireBoundedString(r.capturedAt, 'capturedAt', 64),
    deviceId: requireBoundedString(r.deviceId, 'deviceId', MAX_DEVICE_ID),
    // Forwarded verbatim: it is part of the signed payload, and the upstream
    // checks it against the enrolled device rather than trusting it.
    capturingOfficerId: requireBoundedString(r.capturingOfficerId, 'capturingOfficerId', 64),
    vectorClock: vectorClockOf(r.vectorClock),
    deviceSignature: requireBoundedString(r.deviceSignature, 'deviceSignature', MAX_SIGNATURE),
    signedPayloadHash: requireBoundedString(r.signedPayloadHash, 'signedPayloadHash', MAX_HASH),
  };
}

export function enrollFieldDeviceHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'enrollFieldDevice', async (ctx, session, agency) => {
    const body = await readJsonBody(ctx);
    const deviceId = requireBoundedString(body.deviceId, 'deviceId', MAX_DEVICE_ID);
    // The PUBLIC half only. A device's private key never leaves the device, and
    // there is no field on this route that could carry one.
    const publicKeyPem = requireBoundedString(body.publicKeyPem, 'publicKeyPem', MAX_PUBLIC_KEY_PEM);

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.enrollDevice,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { deviceId, publicKeyPem },
    });

    if (upstream.status === 201 || upstream.status === 200) {
      const status = field(upstream.body, 'status');
      return {
        status: upstream.status === 201 ? 201 : 200,
        body: {
          status: typeof status === 'string' ? status : 'ENROLLED',
          deviceId,
          // From the SESSION, not the upstream echo — the same rule as every
          // other agency-bearing response on this boundary.
          agency,
        },
      };
    }
    if (upstream.status === 403) return FORBIDDEN;
    if (upstream.status === 400) return { status: 400, body: { error: 'INVALID_REQUEST' } };
    return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
  });
}

export function syncFieldScoresHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'syncFieldScores', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    const records = body.records;
    if (!Array.isArray(records) || records.length === 0) {
      throw new HttpError(400, 'INVALID_BATCH', '"records" must be a non-empty array.');
    }
    if (records.length > MAX_RECORDS) {
      throw new HttpError(
        400,
        'INVALID_BATCH',
        `A batch may carry at most ${MAX_RECORDS} records. Split the upload.`,
      );
    }
    const forwarded = records.map((record, index) => scoreRecordOf(record, index));

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.syncScores,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { records: forwarded },
    });

    if (upstream.status === 200) {
      const results = field(upstream.body, 'results') ?? [];
      // The one payload on this boundary without an explicit projection — see
      // leak-guard.ts. It fails closed rather than being trusted.
      assertNoLeakedFields(results, ctx.correlationId);
      return { status: 200, body: { status: 'SYNCED', results } };
    }
    if (upstream.status === 403) return FORBIDDEN;
    if (upstream.status === 400) return { status: 400, body: { error: 'INVALID_BATCH' } };
    return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
  });
}

/**
 * Conflict adjudication. `409 NO_CONFLICT` is preserved verbatim: it is the
 * officer-visible state meaning "there is nothing here to resolve", which is a
 * different instruction from "this failed".
 */
export function resolveFieldSyncConflictHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'resolveFieldSyncConflict', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    const applicationId = requireUuid(body.applicationId, 'applicationId');
    const scoreId = requireUuid(body.scoreId, 'scoreId');
    const resolution = requireBoundedString(body.resolution, 'resolution', MAX_RESOLUTION);

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.resolveConflict,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { applicationId, scoreId, resolution },
    });

    if (upstream.status === 200) {
      return { status: 200, body: { status: 'RESOLVED', applicationId, scoreId } };
    }
    // SCORE_NOT_FOUND and NOT_FOUND are both bare 404s: distinguishing them
    // would tell a caller whether a score id they guessed exists.
    if (upstream.status === 404) return NOT_FOUND;
    if (upstream.status === 409) return conflictResult(upstream.body);
    if (upstream.status === 403) return FORBIDDEN;
    if (upstream.status === 400) return { status: 400, body: { error: 'INVALID_REQUEST' } };
    return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
  });
}
