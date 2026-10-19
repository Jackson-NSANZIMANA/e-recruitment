// ══════════════════════════════════════════════════════════════════
// biometric-service — RecordEvidence use case (ADR-037)
//
// A screening officer's tablet submits a signed USRP-BIO-EVIDENCE.v1 record.
// The checks run in this order; each refusal is a return value:
//
//   1. image guard + exact schema           → INVALID (IMAGE_PAYLOAD_REFUSED | SCHEMA_INVALID)
//   2. record agency == officer agency      → UNTRUSTED (AGENCY_MISMATCH), audited
//   3. reference source authorised          → INVALID (REFERENCE_SOURCE_NOT_AUTHORISED)
//   4. outcome / consent consistency        → INVALID (…)
//   5. capturedAt window                    → INVALID (CAPTURED_AT_OUT_OF_RANGE)
//   6. mode gate                            → BIOMETRIC_OFF | MODE_MISMATCH
//   7. in ONE transaction, officer bound:
//        device known, same agency, live, key id matches  → UNTRUSTED, audited
//        Ed25519 signature over canonicalJson(record)     → UNTRUSTED (SIGNATURE_INVALID), audited
//        rls/0034 write boundary re-checks all of it, binds the ticket,
//        refuses a replay                                  → RECORDED | ALREADY_RECORDED | REPLAY_CONFLICT
//        stage BIOMETRIC_EVIDENCE_RECORDED audit (+ the v1.1 result event
//        for an ADVISORY attempted record only)
//
// SHADOW: stored, never shown — the outcome is not returned, no result event
// is emitted, and officer reads cannot see the row (engine RLS).
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { verifyEd25519 } from '@usrp/shared-security';
import { newEnvelope, type EventContext } from '@usrp/shared-events';
import type { Agency, AuditEvent, BiometricVerificationCompletedEvent, USRPEvent } from '@usrp/shared-types';
import {
  checkEvidenceConsistency,
  deviceKeyId,
  evidenceDigest,
  evidenceSigningInput,
  isCapturedAtAcceptable,
  parseEvidenceRequest,
  type BiometricLegalBasis,
  type EvidenceRecord,
  type EvidenceRejection,
} from '../domain/evidence-record.js';
import { modeGate, type BiometricMode, type RecordingMode } from '../domain/biometric-mode.js';
import { thresholdPolicy, type EvidenceOutcome } from '../domain/threshold-policy.js';
import type { ReferenceSourceRegistry } from '../ports/reference-source.js';
import type { DeviceKey, EngineRefusal, EvidenceEventDispatcher, EvidenceStore } from '../ports/evidence-store.js';

export type TrustRefusal =
  | 'AGENCY_MISMATCH'
  | 'UNKNOWN_DEVICE'
  | 'DEVICE_WRONG_AGENCY'
  | 'DEVICE_REVOKED'
  | 'KEY_MISMATCH'
  | 'SIGNATURE_INVALID';

export type InvalidReason =
  | EvidenceRejection
  | 'REFERENCE_SOURCE_NOT_AUTHORISED'
  | 'THRESHOLD_POLICY_NOT_IN_FORCE'
  | 'UNKNOWN_TICKET';

export type RecordEvidenceOutcome =
  | {
      readonly kind: 'RECORDED';
      readonly recordId: string;
      readonly mode: RecordingMode;
      /** Present only in ADVISORY: a SHADOW outcome is never shown. */
      readonly outcome: EvidenceOutcome | null;
      readonly receivedAt: string;
    }
  | { readonly kind: 'ALREADY_RECORDED'; readonly recordId: string; readonly mode: RecordingMode }
  | { readonly kind: 'REPLAY_CONFLICT' }
  | { readonly kind: 'INVALID'; readonly reason: InvalidReason }
  | { readonly kind: 'UNTRUSTED'; readonly reason: TrustRefusal }
  | { readonly kind: 'BIOMETRIC_OFF' }
  | { readonly kind: 'MODE_MISMATCH'; readonly configuredMode: RecordingMode };

export interface RecordEvidenceCommand {
  readonly agency: Agency;
  readonly officerId: string;
  readonly body: unknown;
  readonly context: EventContext;
}

export interface RecordEvidenceDeps {
  readonly store: EvidenceStore;
  readonly events: EvidenceEventDispatcher;
  readonly referenceSources: ReferenceSourceRegistry;
  readonly modeFor: (agency: Agency) => BiometricMode;
  readonly legalBasis: BiometricLegalBasis;
  /** The one threshold policy devices must use in this deployment. */
  readonly thresholdPolicyVersion: string;
  readonly now?: () => Date;
}

const CORRELATION_RE = /^[A-Za-z0-9._:-]{3,128}$/;

/** The engine stores only a well-formed correlation id; replace anything else. */
export function safeCorrelationId(value: string): string {
  return CORRELATION_RE.test(value) ? value : randomUUID();
}

export class RecordEvidenceService {
  readonly #deps: RecordEvidenceDeps;

  constructor(deps: RecordEvidenceDeps) {
    this.#deps = deps;
  }

  async record(command: RecordEvidenceCommand): Promise<RecordEvidenceOutcome> {
    const now = (this.#deps.now ?? ((): Date => new Date()))();
    const parsed = parseEvidenceRequest(command.body);
    if (!parsed.ok) return { kind: 'INVALID', reason: parsed.reason };
    const { record, signature } = parsed.value;
    const correlationId = safeCorrelationId(command.context.correlationId);
    const context: EventContext = { ...command.context, correlationId };

    if (record.agency !== command.agency) {
      await this.#deps.store.run(command.officerId, async (uow) => {
        await uow.stage([refusalAudit(command, record, 'AGENCY_MISMATCH', context)]);
      });
      return { kind: 'UNTRUSTED', reason: 'AGENCY_MISMATCH' };
    }
    if (this.#deps.referenceSources.source(record.referenceSource).status === 'NOT_AUTHORISED') {
      return { kind: 'INVALID', reason: 'REFERENCE_SOURCE_NOT_AUTHORISED' };
    }
    const inconsistency = checkEvidenceConsistency(record, this.#deps.legalBasis);
    if (inconsistency !== null) return { kind: 'INVALID', reason: inconsistency };
    if (record.thresholdPolicyVersion !== this.#deps.thresholdPolicyVersion) {
      return { kind: 'INVALID', reason: 'THRESHOLD_POLICY_NOT_IN_FORCE' };
    }
    if (!isCapturedAtAcceptable(record.capturedAt, now)) return { kind: 'INVALID', reason: 'CAPTURED_AT_OUT_OF_RANGE' };

    const gate = modeGate(this.#deps.modeFor(command.agency), record.mode);
    if (gate.kind !== 'RECORD') return gate;
    const mode = gate.mode;

    let durable: readonly USRPEvent[] = [];
    const outcome = await this.#deps.store.run(command.officerId, async (uow): Promise<RecordEvidenceOutcome> => {
      const device = await uow.device(record.deviceId);
      const refusal = deviceRefusal(device, command.agency, record);
      if (refusal !== null) {
        await uow.stage([refusalAudit(command, record, refusal, context)]);
        return { kind: 'UNTRUSTED', reason: refusal };
      }
      if (device === null || !verifyEd25519(device.publicKeyPem, evidenceSigningInput(record), signature)) {
        await uow.stage([refusalAudit(command, record, 'SIGNATURE_INVALID', context)]);
        return { kind: 'UNTRUSTED', reason: 'SIGNATURE_INVALID' };
      }

      const result = await uow.record({
        agency: command.agency,
        officerId: command.officerId,
        record,
        mode,
        recordDigest: evidenceDigest(record),
        signature,
        correlationId,
      });
      switch (result.outcome) {
        case 'REFUSED': {
          const reason: EngineRefusal = result.reason;
          if (reason === 'UNKNOWN_TICKET') return { kind: 'INVALID', reason: 'UNKNOWN_TICKET' };
          await uow.stage([refusalAudit(command, record, reason, context)]);
          return { kind: 'UNTRUSTED', reason };
        }
        case 'REPLAY_CONFLICT':
          return { kind: 'REPLAY_CONFLICT' };
        case 'ALREADY_RECORDED':
          return { kind: 'ALREADY_RECORDED', recordId: record.recordId, mode: result.mode };
        case 'RECORDED': {
          const events = recordedEvents(command, record, mode, result.applicantId, context);
          await uow.stage(events);
          durable = events;
          return {
            kind: 'RECORDED',
            recordId: record.recordId,
            mode,
            outcome: mode === 'ADVISORY' ? record.outcome : null,
            receivedAt: result.receivedAt,
          };
        }
      }
    });

    if (durable.length > 0) await this.#deps.events.dispatch(durable);
    return outcome;
  }
}

/** The TS mirror of the engine's device checks (the engine re-checks). */
function deviceRefusal(device: DeviceKey | null, agency: Agency, record: EvidenceRecord): TrustRefusal | null {
  if (device === null) return 'UNKNOWN_DEVICE';
  if (device.agency !== agency) return 'DEVICE_WRONG_AGENCY';
  if (device.revoked) return 'DEVICE_REVOKED';
  let keyId: string;
  try {
    keyId = deviceKeyId(device.publicKeyPem);
  } catch {
    return 'KEY_MISMATCH';
  }
  return keyId === record.keyId ? null : 'KEY_MISMATCH';
}

function refusalAudit(
  command: RecordEvidenceCommand,
  record: EvidenceRecord,
  reason: TrustRefusal,
  context: EventContext,
): AuditEvent {
  return {
    ...newEnvelope(context),
    eventType: 'AUDIT_ENTRY',
    entityType: 'APPLICATION',
    entityId: record.applicationId,
    action: 'BIOMETRIC_EVIDENCE_REFUSED',
    performedBy: command.officerId,
    agency: command.agency,
    metadata: { reason, recordId: record.recordId, deviceId: record.deviceId },
  };
}

function recordedEvents(
  command: RecordEvidenceCommand,
  record: EvidenceRecord,
  mode: RecordingMode,
  applicantId: string,
  context: EventContext,
): readonly USRPEvent[] {
  const audit: AuditEvent = {
    ...newEnvelope(context),
    eventType: 'AUDIT_ENTRY',
    entityType: 'APPLICATION',
    entityId: record.applicationId,
    action: 'BIOMETRIC_EVIDENCE_RECORDED',
    performedBy: command.officerId,
    agency: command.agency,
    metadata: {
      recordId: record.recordId,
      mode,
      outcome: record.outcome,
      referenceSource: record.referenceSource,
      method: record.method,
      consentState: record.consentState,
      thresholdPolicyVersion: record.thresholdPolicyVersion,
    },
  };
  // SHADOW never reaches the identity projection; neither does a non-capture.
  if (mode !== 'ADVISORY' || record.outcome === 'NOT_ATTEMPTED'
      || record.livenessScoreBp === null || record.matchScoreBp === null
      || record.referenceSource === 'NONE') {
    return [audit];
  }
  const policy = thresholdPolicy(record.thresholdPolicyVersion);
  if (policy === null) return [audit];
  const result: BiometricVerificationCompletedEvent = {
    ...newEnvelope(context),
    eventType: 'BIOMETRIC_VERIFICATION_COMPLETED',
    schemaVersion: '1.1',
    applicantId,
    sessionId: record.recordId,
    recordId: record.recordId,
    method: 'FACE_1_1_ON_DEVICE',
    referenceSource: record.referenceSource,
    mode: 'ADVISORY',
    livenessScore: record.livenessScoreBp / 10_000,
    livenessPass: record.livenessScoreBp >= policy.livenessPassBp,
    faceMatchConfidence: record.matchScoreBp / 100,
    faceMatchPass: record.outcome === 'MATCH',
  };
  return [audit, result];
}
