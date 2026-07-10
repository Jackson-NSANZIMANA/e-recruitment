// ══════════════════════════════════════════════════════════════════
// biometric-service — Biometric decision (pure domain)
//
// Given liveness + face-match scores and the configured thresholds, decide
// pass/fail per dimension and overall. Pure and total. Fail-closed: a score
// exactly AT the threshold passes; anything below fails; overall "verified"
// requires BOTH. No biometric data ever reaches this layer — scores only.
// ══════════════════════════════════════════════════════════════════

export interface BiometricScores {
  readonly livenessScore: number;       // 0..1
  readonly faceMatchConfidence: number; // 0..100
}

export interface BiometricThresholds {
  readonly livenessThreshold: number;
  readonly faceMatchThreshold: number;
}

export interface BiometricDecision {
  readonly livenessPass: boolean;
  readonly faceMatchPass: boolean;
  readonly verified: boolean;
}

export function evaluateBiometric(
  scores: BiometricScores,
  thresholds: BiometricThresholds,
): BiometricDecision {
  const livenessPass = scores.livenessScore >= thresholds.livenessThreshold;
  const faceMatchPass = scores.faceMatchConfidence >= thresholds.faceMatchThreshold;
  return { livenessPass, faceMatchPass, verified: livenessPass && faceMatchPass };
}
