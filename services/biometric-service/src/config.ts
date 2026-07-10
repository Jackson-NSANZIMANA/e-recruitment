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
import {
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
}

export function loadBiometricConfig(source: EnvSource = process.env): BiometricServiceConfig {
  const env = loadEnv(
    {
      QR_INVITATION_PUBLIC_KEY_B64: string({ minLength: 40 }), // base64 SPKI PEM (public)
      BIOMETRIC_LIVENESS_THRESHOLD: withDefault(string(), '0.85'),
      BIOMETRIC_FACE_MATCH_THRESHOLD: withDefault(string(), '85.0'),
    },
    source,
  );

  const qrInvitationPublicKeyPem = Buffer.from(env.QR_INVITATION_PUBLIC_KEY_B64, 'base64').toString('utf8');
  createPublicKey(qrInvitationPublicKeyPem); // fail loud at boot if invalid

  return {
    runtime: loadRuntimeConfig('biometric-service', source),
    auth: loadAuthVerifyConfig(source),
    qrInvitationPublicKeyPem,
    thresholds: {
      livenessThreshold: Number(env.BIOMETRIC_LIVENESS_THRESHOLD),
      faceMatchThreshold: Number(env.BIOMETRIC_FACE_MATCH_THRESHOLD),
    },
  };
}
