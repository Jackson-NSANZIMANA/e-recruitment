// ══════════════════════════════════════════════════════════════════
// field-sync-service — Batch score-sync HTTP ingress
//
// POST /v1/field-sync/scores — an OFFICER-authenticated batch upload from a
// tablet reconnecting after offline capture. The officer's agency comes from
// the token. Each uploaded record is UNTRUSTED input: it is shape-validated
// here (structure only) and cryptographically verified in the core (the device
// signature is the real integrity gate — a malformed shape is a 400; a
// well-formed but forged record is REJECTED per-record with 200). The response
// reports each record's outcome so a safe re-upload converges.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import type { FieldScoreRecord, PhysicalTestMetrics } from '@usrp/shared-types';
import type { SyncFieldScoresService } from '../../application/sync-field-scores.service.js';

export const SYNC_SCORES_PATH = '/v1/field-sync/scores';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FITNESS = new Set(['FIT', 'UNFIT', 'PENDING_REVIEW']);

interface SyncBody {
  readonly records?: unknown;
}

const asObject = (v: unknown): Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new HttpError(400, 'INVALID_RECORD', 'Expected an object.');
  }
  return v as Record<string, unknown>;
};

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new HttpError(400, 'INVALID_RECORD', `Field "${field}" must be a non-empty string.`);
  }
  return v;
}

function num(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new HttpError(400, 'INVALID_RECORD', `Field "${field}" must be a finite number.`);
  }
  return v;
}

function parseMetrics(v: unknown): PhysicalTestMetrics {
  const m = asObject(v);
  const status = str(m['medicalFitnessStatus'], 'metrics.medicalFitnessStatus');
  if (!FITNESS.has(status)) {
    throw new HttpError(400, 'INVALID_RECORD', 'metrics.medicalFitnessStatus is not a valid value.');
  }
  const notes = m['additionalNotes'];
  if (notes !== undefined && typeof notes !== 'string') {
    throw new HttpError(400, 'INVALID_RECORD', 'metrics.additionalNotes must be a string.');
  }
  return {
    heightCm: num(m['heightCm'], 'metrics.heightCm'),
    weightKg: num(m['weightKg'], 'metrics.weightKg'),
    run3kmTimeSeconds: num(m['run3kmTimeSeconds'], 'metrics.run3kmTimeSeconds'),
    chestCm: num(m['chestCm'], 'metrics.chestCm'),
    medicalFitnessStatus: status as PhysicalTestMetrics['medicalFitnessStatus'],
    ...(notes !== undefined ? { additionalNotes: notes } : {}),
  };
}

function parseVectorClock(v: unknown): Record<string, number> {
  const raw = asObject(v);
  const clock: Record<string, number> = {};
  for (const [device, count] of Object.entries(raw)) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      throw new HttpError(400, 'INVALID_RECORD', `vectorClock["${device}"] must be a non-negative integer.`);
    }
    clock[device] = count;
  }
  return clock;
}

function parseRecord(v: unknown): FieldScoreRecord {
  const r = asObject(v);
  const applicationId = str(r['applicationId'], 'applicationId');
  if (!UUID_RE.test(applicationId)) {
    throw new HttpError(400, 'INVALID_RECORD', 'applicationId must be a UUID.');
  }
  return {
    applicationId,
    qrInvitationCode: str(r['qrInvitationCode'], 'qrInvitationCode'),
    metrics: parseMetrics(r['metrics']),
    capturedAt: str(r['capturedAt'], 'capturedAt'),
    deviceId: str(r['deviceId'], 'deviceId'),
    capturingOfficerId: str(r['capturingOfficerId'], 'capturingOfficerId'),
    vectorClock: parseVectorClock(r['vectorClock']),
    deviceSignature: str(r['deviceSignature'], 'deviceSignature'),
    signedPayloadHash: str(r['signedPayloadHash'], 'signedPayloadHash'),
  };
}

export function syncScoresRoute(service: SyncFieldScoresService, verify: AuthVerifier): Route {
  return {
    method: 'POST',
    path: SYNC_SCORES_PATH,
    handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
      if (principal.kind !== 'officer') {
        throw new HttpError(403, 'FORBIDDEN', 'Officer principal required.');
      }
      const body = await ctx.json<SyncBody>();
      if (!Array.isArray(body.records) || body.records.length === 0) {
        throw new HttpError(400, 'INVALID_BATCH', 'Field "records" must be a non-empty array.');
      }
      const records = body.records.map(parseRecord);

      const outcome = await service.sync({
        records,
        actorAgency: principal.agency,
        context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
      });

      return { status: 200, body: { status: 'SYNCED', results: outcome.results } };
    }),
  };
}
