// ══════════════════════════════════════════════════════════════════
// biometric-service — NIDA_PORTRAIT matcher (fails closed, ADR-037 §2)
//
// The production binding of the server-side BiometricMatcher port. NIDA's
// portrait service is not authorised (g2g-authorization-prerequisites.md), so
// every call is refused with ReferenceSourceNotAuthorisedError → 503
// REFERENCE_SOURCE_NOT_AUTHORISED. Nothing is captured, sent or scored. When
// authorisation exists, a real adapter replaces this one (new ADR), and must
// delete the ephemeral capture as soon as it is scored.
// ══════════════════════════════════════════════════════════════════

import type { BiometricScores } from '../domain/biometric.js';
import { ReferenceSourceNotAuthorisedError } from '../domain/biometric.errors.js';
import type { BiometricMatcher, CaptureReference } from '../ports/biometric-matcher.js';

export class NidaPortraitMatcher implements BiometricMatcher {
  match(_capture: CaptureReference): Promise<BiometricScores> {
    return Promise.reject(new ReferenceSourceNotAuthorisedError('NIDA_PORTRAIT'));
  }
}
