// ══════════════════════════════════════════════════════════════════
// biometric-service — EvidenceStore adapter (PostgreSQL, rls/0034)
//
// One transaction: SET LOCAL ROLE usrp_biometric_service, bind the verified
// officer to usrp.biometric_actor_id, then read the device key and call
// <agency>_ops.record_biometric_evidence(…). usrp_biometric_service holds no
// table privilege on the evidence store at all; the function owner does, and
// it re-checks the officer, device, key, ticket and replay itself.
//
// SQLSTATE 42501 from the function is an authorization refusal of the actor
// (disabled, wrong agency, not a screening officer) → EvidenceForbiddenError
// (403). Anything else that throws is infrastructure → EvidencePersistenceError.
// ══════════════════════════════════════════════════════════════════

import {
  PgOutboxDispatcher,
  sql,
  stageOutboxEvents,
  type SqlTransaction,
} from '@usrp/shared-database';
import type { EventBus } from '@usrp/shared-events';
import { AGENCIES, type Agency, type USRPEvent } from '@usrp/shared-types';
import { EvidencePersistenceError } from '../domain/biometric.errors.js';
import type {
  DeviceKey,
  EngineRefusal,
  EvidenceEventDispatcher,
  EvidenceStore,
  EvidenceUnitOfWork,
  RecordEvidenceInput,
  RecordEvidenceResult,
} from '../ports/evidence-store.js';

export const BIOMETRIC_OUTBOX_PRODUCER = 'biometric-service';
const DB_ROLE = 'usrp_biometric_service';
const SCHEMA: Readonly<Record<Agency, string>> = { RDF: 'rdf_ops', RNP: 'rnp_ops', RCS: 'rcs_ops' };
const ENGINE_REFUSALS: ReadonlySet<string> = new Set<EngineRefusal>([
  'UNKNOWN_DEVICE', 'DEVICE_WRONG_AGENCY', 'DEVICE_REVOKED', 'KEY_MISMATCH', 'UNKNOWN_TICKET',
]);

/** The actor was refused by the engine (42501). */
export class EvidenceForbiddenError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The officer may not record biometric evidence', options);
    this.name = 'EvidenceForbiddenError';
  }
}

function isForbidden(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '42501';
}

function instant(value: unknown): string {
  if (typeof value !== 'string' && !(value instanceof Date)) {
    throw new EvidencePersistenceError('Evidence store returned an unexpected timestamp');
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new EvidencePersistenceError('Evidence store returned an unexpected timestamp');
  return d.toISOString();
}

function toResult(raw: unknown): RecordEvidenceResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EvidencePersistenceError('Evidence store returned an unexpected shape');
  }
  const r = raw as Record<string, unknown>;
  switch (r['outcome']) {
    case 'RECORDED':
      if (typeof r['evidenceId'] !== 'string' || typeof r['applicantId'] !== 'string') break;
      return { outcome: 'RECORDED', evidenceId: r['evidenceId'], applicantId: r['applicantId'], receivedAt: instant(r['receivedAt']) };
    case 'ALREADY_RECORDED':
      if (typeof r['evidenceId'] !== 'string' || (r['mode'] !== 'SHADOW' && r['mode'] !== 'ADVISORY')) break;
      return { outcome: 'ALREADY_RECORDED', evidenceId: r['evidenceId'], mode: r['mode'], receivedAt: instant(r['receivedAt']) };
    case 'REPLAY_CONFLICT':
      return { outcome: 'REPLAY_CONFLICT' };
    case 'REFUSED':
      if (typeof r['reason'] === 'string' && ENGINE_REFUSALS.has(r['reason'])) {
        return { outcome: 'REFUSED', reason: r['reason'] as EngineRefusal };
      }
      break;
  }
  throw new EvidencePersistenceError('Evidence store returned an unknown outcome');
}

class PgUnitOfWork implements EvidenceUnitOfWork {
  constructor(private readonly tx: SqlTransaction) {}

  async device(deviceId: string): Promise<DeviceKey | null> {
    const rows = await this.tx<{ device_id: string; public_key_pem: string; agency: string; revoked_at: Date | null }[]>`
      SELECT device_id, public_key_pem, agency::text AS agency, revoked_at
      FROM public_core.field_devices WHERE device_id = ${deviceId}
    `;
    const row = rows[0];
    if (!row) return null;
    if (!(AGENCIES as readonly string[]).includes(row.agency)) {
      throw new EvidencePersistenceError('Device registry returned an unknown agency');
    }
    return {
      deviceId: row.device_id,
      publicKeyPem: row.public_key_pem,
      agency: row.agency as Agency,
      revoked: row.revoked_at !== null,
    };
  }

  async record(input: RecordEvidenceInput): Promise<RecordEvidenceResult> {
    const r = input.record;
    const schema = SCHEMA[input.agency];
    const rows = await this.tx<{ result: unknown }[]>`
      SELECT ${sql(schema)}.record_biometric_evidence(
        ${input.officerId}::uuid, ${r.recordId}::uuid, ${r.applicationId}::uuid, ${r.ticketId},
        ${r.referenceSource}, ${r.method}, ${r.consentState}, ${r.outcome}, ${r.notAttemptedReason},
        ${r.livenessScoreBp}::integer, ${r.matchScoreBp}::integer, ${r.modelId}, ${r.modelVersion},
        ${r.thresholdPolicyVersion}, ${input.mode}, ${r.deviceId}, ${r.keyId}, ${input.recordDigest},
        ${input.signature}, ${r.capturedAt}::timestamptz, ${input.correlationId}
      ) AS result
    `;
    return toResult(rows[0]?.result);
  }

  async stage(events: readonly USRPEvent[]): Promise<void> {
    await stageOutboxEvents(this.tx, events, BIOMETRIC_OUTBOX_PRODUCER);
  }
}

export class PgEvidenceStore implements EvidenceStore {
  async run<T>(officerId: string, work: (uow: EvidenceUnitOfWork) => Promise<T>): Promise<T> {
    try {
      return await sql.begin(async (tx): Promise<T> => {
        await tx`SET LOCAL ROLE ${sql(DB_ROLE)}`;
        await tx`SELECT set_config('usrp.biometric_actor_id', ${officerId}, true)`;
        return work(new PgUnitOfWork(tx));
      });
    } catch (err) {
      if (isForbidden(err)) throw new EvidenceForbiddenError({ cause: err });
      if (err instanceof EvidencePersistenceError) throw err;
      throw new EvidencePersistenceError('Recording biometric evidence failed', { cause: err });
    }
  }
}

export class PgEvidenceEventDispatcher extends PgOutboxDispatcher<USRPEvent> implements EvidenceEventDispatcher {
  constructor(bus: EventBus) {
    super(bus, BIOMETRIC_OUTBOX_PRODUCER);
  }
}
