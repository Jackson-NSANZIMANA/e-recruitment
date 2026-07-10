// ══════════════════════════════════════════════════════════════════
// @usrp/biometric-service — Public API & composition root
//
// Wires the check-in gate use case to its matcher adapter. DB-free: it emits
// biometric.result and identity-service persists the outcome. The caller
// supplies the EventBus (InMemory in tests, Kafka in prod).
// ══════════════════════════════════════════════════════════════════

import type { EventBus } from '@usrp/shared-events';
import { VerifyBiometricService } from './application/verify-biometric.service.js';
import { MockBiometricMatcher } from './adapters/mock-matcher.js';
import type { BiometricServiceConfig } from './config.js';

export interface BiometricService {
  readonly verifyBiometric: VerifyBiometricService;
}

export function createBiometricService(
  config: BiometricServiceConfig,
  eventBus: EventBus,
): BiometricService {
  return {
    verifyBiometric: new VerifyBiometricService({
      matcher: new MockBiometricMatcher(),
      qrInvitationPublicKeyPem: config.qrInvitationPublicKeyPem,
      thresholds: config.thresholds,
      eventBus,
    }),
  };
}

// ── Re-exports ────────────────────────────────────────────────────
export { VerifyBiometricService } from './application/verify-biometric.service.js';
export type {
  VerifyBiometricCommand,
  VerifyBiometricDeps,
  VerifyBiometricOutcome,
} from './application/verify-biometric.service.js';
export { VERIFY_BIOMETRIC_PATH, verifyBiometricRoute } from './adapters/http/verify-biometric.controller.js';
export { evaluateBiometric } from './domain/biometric.js';
export type { BiometricScores, BiometricDecision, BiometricThresholds } from './domain/biometric.js';
export { MockBiometricMatcher } from './adapters/mock-matcher.js';
export { BiometricMatchError } from './domain/biometric.errors.js';
export { loadBiometricConfig } from './config.js';
export type { BiometricServiceConfig, BiometricThresholdsConfig } from './config.js';
export type { BiometricMatcher, CaptureReference } from './ports/biometric-matcher.js';
