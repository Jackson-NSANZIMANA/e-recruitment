// ══════════════════════════════════════════════════════════════════
// biometric-service — BiometricMatcher adapter (dev mock)
//
// Stands in for the real liveness + 1:1 face-match engine. Returns fixed
// PASSING scores so the happy path works on a dev stack; the selfcheck injects
// its own stub matcher to drive fail/threshold-boundary cases. A real engine
// (WebRTC capture → liveness model → face embedding compare) replaces this
// behind the same port with no change to the service core.
// ══════════════════════════════════════════════════════════════════

import type { BiometricScores } from '../domain/biometric.js';
import type { BiometricMatcher, CaptureReference } from '../ports/biometric-matcher.js';

export class MockBiometricMatcher implements BiometricMatcher {
  async match(_capture: CaptureReference): Promise<BiometricScores> {
    return { livenessScore: 0.95, faceMatchConfidence: 96.0 };
  }
}
