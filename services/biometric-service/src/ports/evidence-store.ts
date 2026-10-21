// ══════════════════════════════════════════════════════════════════
// biometric-service — EvidenceStore port (ADR-037 §5, §8)
//
// One unit of work = one database transaction as usrp_biometric_service with
// the verified officer bound to it. Inside it the use case reads the device
// key, verifies the signature, asks the rls/0034 write boundary to record,
// and stages the audit / result events — all or nothing. A trust refusal
// stages its audit in the same transaction and commits nothing else.
// ══════════════════════════════════════════════════════════════════

import type { Agency, USRPEvent } from '@usrp/shared-types';
import type { EvidenceRecord } from '../domain/evidence-record.js';
import type { RecordingMode } from '../domain/biometric-mode.js';

export interface DeviceKey {
  readonly deviceId: string;
  readonly publicKeyPem: string;
  readonly agency: Agency;
  readonly revoked: boolean;
}

export interface RecordEvidenceInput {
  readonly agency: Agency;
  readonly officerId: string;
  readonly record: EvidenceRecord;
  /** The mode in force (the record's declared mode already agreed with it). */
  readonly mode: RecordingMode;
  readonly recordDigest: string;
  readonly signature: string;
  readonly correlationId: string;
}

export type EngineRefusal = 'UNKNOWN_DEVICE' | 'DEVICE_WRONG_AGENCY' | 'DEVICE_REVOKED' | 'KEY_MISMATCH' | 'UNKNOWN_TICKET';

export type RecordEvidenceResult =
  | {
      readonly outcome: 'RECORDED';
      readonly evidenceId: string;
      readonly applicantId: string;
      readonly receivedAt: string;
      /** The application was already admitted at the gate when this arrived. */
      readonly afterAdmission: boolean;
    }
  | { readonly outcome: 'ALREADY_RECORDED'; readonly evidenceId: string; readonly mode: RecordingMode; readonly receivedAt: string }
  | { readonly outcome: 'REPLAY_CONFLICT' }
  | { readonly outcome: 'REFUSED'; readonly reason: EngineRefusal };

export interface EvidenceUnitOfWork {
  device(deviceId: string): Promise<DeviceKey | null>;
  record(input: RecordEvidenceInput): Promise<RecordEvidenceResult>;
  stage(events: readonly USRPEvent[]): Promise<void>;
}

export interface EvidenceStore {
  /** Run `work` in one transaction with `officerId` bound as the actor. */
  run<T>(officerId: string, work: (uow: EvidenceUnitOfWork) => Promise<T>): Promise<T>;
}

/** Post-commit fast path (the outbox relay is the durable path). */
export interface EvidenceEventDispatcher {
  dispatch(events: readonly USRPEvent[]): Promise<void>;
}
