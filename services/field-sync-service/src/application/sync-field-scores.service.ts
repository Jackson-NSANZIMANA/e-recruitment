// ══════════════════════════════════════════════════════════════════
// field-sync-service — SyncFieldScores use case (batch upload)
//
// A tablet, back online, uploads its accumulated signed score records. For EACH
// record, independently:
//   1. Look the device up in the registry. Unenrolled / revoked → REJECT.
//   2. Cross-agency guard: the device's agency must equal the officer's agency.
//   3. Verify the Ed25519 device signature AND the metrics hash
//      (verifyFieldScoreRecord). Tampered → REJECT (never stored).
//   4. Merge into physical_test_scores (vector-clock hybrid resolution).
//   5. On a clean accept/supersede → emit FIELD_SCORE_CAPTURED (application-
//      service advances). On conflict → NO state event: the application is held.
//
// A rejected or stale record does not stop the batch — each record's outcome is
// reported independently, so a re-upload is safe (stale/duplicate → no-op). Only
// an infra fault throws (→ the whole request fails, nothing half-committed).
// ══════════════════════════════════════════════════════════════════

import { verifyFieldScoreRecord, type SignableFieldPayload } from '@usrp/shared-security';
import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type {
  Agency,
  AuditEvent,
  FieldScoreCapturedEvent,
  FieldScoreRecord,
} from '@usrp/shared-types';
import type { FieldScoreStore, SyncOutcome } from '../ports/field-score-store.js';
import type { DeviceRegistry } from '../ports/device-registry.js';

export type RecordStatus =
  | 'ACCEPTED'
  | 'SUPERSEDED'
  | 'CONFLICT'
  | 'STALE'
  | 'DUPLICATE'
  | 'NOT_FOUND'
  | 'REJECTED';

export type RejectReason =
  | 'UNENROLLED_DEVICE'
  | 'REVOKED_DEVICE'
  | 'AGENCY_MISMATCH'
  | 'BAD_SIGNATURE';

export interface RecordSyncResult {
  readonly applicationId: string;
  readonly deviceId: string;
  readonly status: RecordStatus;
  readonly reason?: RejectReason;
  readonly scoreId?: string;
}

export interface SyncFieldScoresCommand {
  readonly records: readonly FieldScoreRecord[];
  /** The uploading officer's agency (from their verified token). */
  readonly actorAgency: Agency;
  readonly context: EventContext;
}

export interface SyncFieldScoresOutcome {
  readonly results: readonly RecordSyncResult[];
}

export interface SyncFieldScoresDeps {
  readonly registry: DeviceRegistry;
  readonly store: FieldScoreStore;
  readonly eventBus: EventBus;
}

export class SyncFieldScoresService {
  constructor(private readonly deps: SyncFieldScoresDeps) {}

  async sync(command: SyncFieldScoresCommand): Promise<SyncFieldScoresOutcome> {
    const results: RecordSyncResult[] = [];
    for (const record of command.records) {
      results.push(await this.syncOne(record, command.actorAgency, command.context));
    }
    return { results };
  }

  private async syncOne(
    record: FieldScoreRecord,
    actorAgency: Agency,
    context: EventContext,
  ): Promise<RecordSyncResult> {
    const base = { applicationId: record.applicationId, deviceId: record.deviceId };

    // 1–2. Device trust: enrolled, not revoked, same agency as the officer.
    const device = await this.deps.registry.find(record.deviceId);
    if (!device) return this.reject(base, 'UNENROLLED_DEVICE', actorAgency, context);
    if (device.revokedAt !== null) return this.reject(base, 'REVOKED_DEVICE', actorAgency, context);
    if (device.agency !== actorAgency) {
      return this.reject(base, 'AGENCY_MISMATCH', actorAgency, context);
    }

    // 3. Signature + hash over the canonical signable payload.
    const payload: SignableFieldPayload = {
      applicationId: record.applicationId,
      qrInvitationCode: record.qrInvitationCode,
      metrics: record.metrics,
      capturedAt: record.capturedAt,
      deviceId: record.deviceId,
      capturingOfficerId: record.capturingOfficerId,
      vectorClock: record.vectorClock,
    };
    const signatureOk = verifyFieldScoreRecord(device.publicKeyPem, payload, {
      deviceSignature: record.deviceSignature,
      signedPayloadHash: record.signedPayloadHash,
    });
    if (!signatureOk) return this.reject(base, 'BAD_SIGNATURE', actorAgency, context);

    // 4. Merge into the CRDT log.
    const outcome = await this.deps.store.sync({
      applicationId: record.applicationId,
      agency: actorAgency,
      qrInvitationCode: record.qrInvitationCode,
      deviceId: record.deviceId,
      capturingOfficerId: record.capturingOfficerId,
      capturedAt: record.capturedAt,
      vectorClock: record.vectorClock,
      deviceSignature: record.deviceSignature,
      signedPayloadHash: record.signedPayloadHash,
      metrics: record.metrics,
    });

    return this.materialise(record, actorAgency, context, outcome);
  }

  /** Emit events for a stored outcome and map it to the per-record result. */
  private async materialise(
    record: FieldScoreRecord,
    agency: Agency,
    context: EventContext,
    outcome: SyncOutcome,
  ): Promise<RecordSyncResult> {
    const base = { applicationId: record.applicationId, deviceId: record.deviceId };

    switch (outcome.kind) {
      case 'ACCEPTED':
      case 'SUPERSEDED': {
        await this.emitCaptured(record, agency, context, outcome.campaignId, outcome.isWalkIn);
        await this.audit(context, record.deviceId, agency, 'FIELD_SCORE_CAPTURED', {
          applicationId: record.applicationId,
          scoreId: outcome.scoreId,
          resolution: outcome.kind,
        });
        return { ...base, status: outcome.kind, scoreId: outcome.scoreId };
      }
      case 'CONFLICT': {
        // No FIELD_SCORE_CAPTURED — the application is HELD for adjudication.
        await this.audit(context, record.deviceId, agency, 'FIELD_SCORE_CONFLICT', {
          applicationId: record.applicationId,
          scoreId: outcome.scoreId,
        });
        return { ...base, status: 'CONFLICT', scoreId: outcome.scoreId };
      }
      case 'STALE':
        return { ...base, status: 'STALE' };
      case 'DUPLICATE':
        return { ...base, status: 'DUPLICATE' };
      case 'NOT_FOUND':
        return { ...base, status: 'NOT_FOUND' };
    }
  }

  private async emitCaptured(
    record: FieldScoreRecord,
    agency: Agency,
    context: EventContext,
    campaignId: string,
    isWalkIn: boolean,
  ): Promise<void> {
    const event: FieldScoreCapturedEvent = {
      ...newEnvelope(context),
      eventType: 'FIELD_SCORE_CAPTURED',
      applicationId: record.applicationId,
      agency,
      campaignId,
      deviceId: record.deviceId,
      capturingOfficerId: record.capturingOfficerId,
      vectorClock: record.vectorClock,
      signedPayloadHash: record.signedPayloadHash,
      isWalkIn,
    };
    await this.deps.eventBus.publish(event);
  }

  private async reject(
    base: { applicationId: string; deviceId: string },
    reason: RejectReason,
    agency: Agency,
    context: EventContext,
  ): Promise<RecordSyncResult> {
    await this.audit(context, base.deviceId, agency, 'FIELD_SCORE_REJECTED', {
      applicationId: base.applicationId,
      reason,
    });
    return { ...base, status: 'REJECTED', reason };
  }

  private async audit(
    context: EventContext,
    deviceId: string,
    agency: Agency,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const audit: AuditEvent = {
      ...newEnvelope(context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'SYSTEM',
      entityId: deviceId,
      action,
      performedBy: 'field-sync-service',
      agency,
      metadata,
    };
    await this.deps.eventBus.publish(audit);
  }
}
