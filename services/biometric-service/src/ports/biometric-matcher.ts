// ══════════════════════════════════════════════════════════════════
// biometric-service — BiometricMatcher port
//
// Scores a capture (a reference to the live frames — e.g. a WebRTC session or
// object-store key; raw frames never enter this service's core or its events).
// Adapters: a dev mock returning passing scores, and — later — a real
// liveness/1:1-face-match engine. The matcher returns SCORES only.
// ══════════════════════════════════════════════════════════════════

import type { BiometricScores } from '../domain/biometric.js';

export interface CaptureReference {
  /** Opaque handle to the captured frames (session id / object key). Not PII data itself. */
  readonly captureRef: string;
  /** The applicant whose enrolled reference the live capture is matched against. */
  readonly applicantId: string;
}

export interface BiometricMatcher {
  match(capture: CaptureReference): Promise<BiometricScores>;
}
