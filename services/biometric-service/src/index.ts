// ══════════════════════════════════════════════════════════════════
// @usrp/biometric-service — Public API & composition root
//
// Two paths (ADR-037):
//   • evidence — device-attested CARD_PORTRAIT records, verified against the
//     field-device registry and stored through the rls/0034 write boundary;
//   • the legacy server-side check-in (/v1/biometric/verify) behind the
//     BiometricMatcher port: the dev mock outside production, the fail-closed
//     NIDA_PORTRAIT matcher in production (not authorised).
// ══════════════════════════════════════════════════════════════════

import { isProduction } from '@usrp/shared-config';
import type { EventBus } from '@usrp/shared-events';
import type { Agency } from '@usrp/shared-types';
import { VerifyBiometricService } from './application/verify-biometric.service.js';
import { RecordEvidenceService } from './application/record-evidence.service.js';
import { MockBiometricMatcher } from './adapters/mock-matcher.js';
import { NidaPortraitMatcher } from './adapters/nida-portrait-matcher.js';
import { FixedReferenceSources } from './adapters/reference-sources.js';
import { PgEvidenceEventDispatcher, PgEvidenceStore } from './adapters/evidence-store.pg.js';
import type { BiometricPolicyView } from './adapters/http/biometric-evidence.controller.js';
import type { BiometricServiceConfig } from './config.js';
import type { BiometricMatcher } from './ports/biometric-matcher.js';

/** Owner decision (ADR-037 §12): consent-or-decline. */
export const BIOMETRIC_LEGAL_BASIS = 'CONSENT_OR_DECLINE' as const;

export interface BiometricService {
  readonly verifyBiometric: VerifyBiometricService;
  readonly recordEvidence: RecordEvidenceService;
  readonly policy: BiometricPolicyView;
}

/** Production never sees the mock: NIDA_PORTRAIT fails closed instead. */
export function serverMatcherFor(production: boolean): BiometricMatcher {
  return production ? new NidaPortraitMatcher() : new MockBiometricMatcher();
}

export function createBiometricService(
  config: BiometricServiceConfig,
  eventBus: EventBus,
): BiometricService {
  const referenceSources = new FixedReferenceSources();
  const modeFor = (agency: Agency): BiometricServiceConfig['modes'][Agency] => config.modes[agency];
  return {
    verifyBiometric: new VerifyBiometricService({
      matcher: serverMatcherFor(isProduction()),
      qrInvitationPublicKeyPem: config.qrInvitationPublicKeyPem,
      thresholds: config.thresholds,
      eventBus,
    }),
    recordEvidence: new RecordEvidenceService({
      store: new PgEvidenceStore(),
      events: new PgEvidenceEventDispatcher(eventBus),
      referenceSources,
      modeFor,
      legalBasis: BIOMETRIC_LEGAL_BASIS,
      thresholdPolicyVersion: config.thresholdPolicyVersion,
    }),
    policy: {
      modeFor,
      thresholdPolicyVersion: config.thresholdPolicyVersion,
      legalBasis: BIOMETRIC_LEGAL_BASIS,
      referenceSources,
    },
  };
}

// ── Re-exports ────────────────────────────────────────────────────
export { VerifyBiometricService } from './application/verify-biometric.service.js';
export type {
  VerifyBiometricCommand,
  VerifyBiometricDeps,
  VerifyBiometricOutcome,
} from './application/verify-biometric.service.js';
export { RecordEvidenceService, safeCorrelationId } from './application/record-evidence.service.js';
export type {
  RecordEvidenceCommand,
  RecordEvidenceDeps,
  RecordEvidenceOutcome,
  TrustRefusal,
  InvalidReason,
} from './application/record-evidence.service.js';
export { VERIFY_BIOMETRIC_PATH, verifyBiometricRoute } from './adapters/http/verify-biometric.controller.js';
export {
  BIOMETRIC_EVIDENCE_PATH,
  BIOMETRIC_POLICY_PATH,
  biometricEvidenceRoutes,
  mapRecordOutcome,
} from './adapters/http/biometric-evidence.controller.js';
export type { BiometricPolicyView } from './adapters/http/biometric-evidence.controller.js';
export { evaluateBiometric } from './domain/biometric.js';
export type { BiometricScores, BiometricDecision, BiometricThresholds } from './domain/biometric.js';
export * from './domain/evidence-record.js';
export * from './domain/threshold-policy.js';
export * from './domain/biometric-mode.js';
export { MockBiometricMatcher } from './adapters/mock-matcher.js';
export { NidaPortraitMatcher } from './adapters/nida-portrait-matcher.js';
export { FixedReferenceSources } from './adapters/reference-sources.js';
export {
  BIOMETRIC_OUTBOX_PRODUCER,
  EvidenceForbiddenError,
  PgEvidenceEventDispatcher,
  PgEvidenceStore,
} from './adapters/evidence-store.pg.js';
export { BiometricMatchError, ReferenceSourceNotAuthorisedError, EvidencePersistenceError } from './domain/biometric.errors.js';
export { loadBiometricConfig } from './config.js';
export type { BiometricServiceConfig, BiometricThresholdsConfig } from './config.js';
export type { BiometricMatcher, CaptureReference } from './ports/biometric-matcher.js';
export type { ReferenceSource, ReferenceSourceRegistry, ReferenceSourceStatus } from './ports/reference-source.js';
export type { EvidenceStore, EvidenceUnitOfWork, DeviceKey, RecordEvidenceResult } from './ports/evidence-store.js';
