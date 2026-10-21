// ══════════════════════════════════════════════════════════════════
// biometric-service — Configuration
//
// The exam-day check-in gate. It verifies the applicant's signed QR OFFLINE
// with the scheduling issuer's PUBLIC key (no DB round-trip) and runs a 1:1
// face-match + liveness check. It is DB-free (like background-vetting): it
// persists nothing itself — it emits biometric.result and identity-service
// records the outcome onto applicant_identities. It needs: runtime, the
// officer auth verify key (ingress is officer-authenticated), the QR
// invitation verify key, and the match thresholds.
// ══════════════════════════════════════════════════════════════════

import { createPublicKey } from 'node:crypto';
import type { Agency } from '@usrp/shared-types';
import { isBiometricMode, type BiometricMode } from './domain/biometric-mode.js';
import { DEFAULT_THRESHOLD_POLICY_VERSION, thresholdPolicy } from './domain/threshold-policy.js';
import {
  EnvValidationError,
  loadAuthVerifyConfig,
  loadEnv,
  loadRuntimeConfig,
  string,
  withDefault,
  type AuthVerifyConfig,
  type EnvSource,
  type RuntimeConfig,
} from '@usrp/shared-config';

export interface BiometricThresholdsConfig {
  readonly livenessThreshold: number;   // 0..1
  readonly faceMatchThreshold: number;  // 0..100
}

export interface BiometricServiceConfig {
  readonly runtime: RuntimeConfig;
  readonly auth: AuthVerifyConfig;
  /** Scheduling issuer public key (SPKI PEM) used to verify the slot-invitation QR. */
  readonly qrInvitationPublicKeyPem: string;
  readonly thresholds: BiometricThresholdsConfig;
  /** ADR-037 §7: per-agency evidence mode; default OFF (fail closed). */
  readonly modes: Readonly<Record<Agency, BiometricMode>>;
  /** The registered threshold policy devices must use (ADR-037 §6). */
  readonly thresholdPolicyVersion: string;
}

export function loadBiometricConfig(source: EnvSource = process.env): BiometricServiceConfig {
  const env = loadEnv(
    {
      QR_INVITATION_PUBLIC_KEY_B64: string({ minLength: 40 }), // base64 SPKI PEM (public)
      BIOMETRIC_LIVENESS_THRESHOLD: withDefault(string(), '0.85'),
      BIOMETRIC_FACE_MATCH_THRESHOLD: withDefault(string(), '85.0'),
      BIOMETRIC_MODE_RDF: withDefault(string(), 'OFF'),
      BIOMETRIC_MODE_RNP: withDefault(string(), 'OFF'),
      BIOMETRIC_MODE_RCS: withDefault(string(), 'OFF'),
      BIOMETRIC_THRESHOLD_POLICY: withDefault(string(), DEFAULT_THRESHOLD_POLICY_VERSION),
    },
    source,
  );

  const qrInvitationPublicKeyPem = Buffer.from(env.QR_INVITATION_PUBLIC_KEY_B64, 'base64').toString('utf8');
  createPublicKey(qrInvitationPublicKeyPem); // fail loud at boot if invalid

  const livenessThreshold = Number(env.BIOMETRIC_LIVENESS_THRESHOLD);
  const faceMatchThreshold = Number(env.BIOMETRIC_FACE_MATCH_THRESHOLD);

  const issues: string[] = [];
  if (Number.isNaN(livenessThreshold) || livenessThreshold < 0 || livenessThreshold > 1) {
    issues.push('BIOMETRIC_LIVENESS_THRESHOLD must be a number between 0.0 and 1.0');
  }
  if (Number.isNaN(faceMatchThreshold) || faceMatchThreshold < 0 || faceMatchThreshold > 100) {
    issues.push('BIOMETRIC_FACE_MATCH_THRESHOLD must be a number between 0.0 and 100.0');
  }
  const modes = { RDF: env.BIOMETRIC_MODE_RDF, RNP: env.BIOMETRIC_MODE_RNP, RCS: env.BIOMETRIC_MODE_RCS };
  for (const [agency, mode] of Object.entries(modes)) {
    if (!isBiometricMode(mode)) issues.push(`BIOMETRIC_MODE_${agency} must be OFF, SHADOW or ADVISORY (there is no automatic mode)`);
  }
  if (thresholdPolicy(env.BIOMETRIC_THRESHOLD_POLICY) === null) {
    issues.push('BIOMETRIC_THRESHOLD_POLICY must name a registered threshold policy');
  }
  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }

  return {
    runtime: loadRuntimeConfig('biometric-service', source),
    auth: loadAuthVerifyConfig(source),
    qrInvitationPublicKeyPem,
    thresholds: {
      livenessThreshold,
      faceMatchThreshold,
    },
    modes: modes as Record<Agency, BiometricMode>,
    thresholdPolicyVersion: env.BIOMETRIC_THRESHOLD_POLICY,
  };
}
