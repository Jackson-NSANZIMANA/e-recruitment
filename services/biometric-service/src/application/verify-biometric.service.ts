// ══════════════════════════════════════════════════════════════════
// biometric-service — VerifyBiometric use case
//
// The exam-day check-in gate. Given the applicant's signed QR and a capture
// reference (submitted by a check-in officer):
//   1. Verify the QR OFFLINE with the scheduling public key — this is the
//      first real consumer of verifySlotInvitation. Invalid/expired → reject.
//   2. Cross-agency guard: the QR's agency must equal the officer's agency —
//      an RDF officer cannot check in an RNP applicant.
//   3. Run liveness + 1:1 face match (scores only), apply thresholds.
//   4. Emit BIOMETRIC_VERIFICATION_COMPLETED (scores only, no frames) + audit.
//
// Business outcomes are return values; only a matcher infra fault throws.
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { verifySlotInvitation } from '@usrp/shared-security';
import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { Agency, AuditEvent, BiometricVerificationCompletedEvent } from '@usrp/shared-types';
import type { BiometricMatcher } from '../ports/biometric-matcher.js';
import { evaluateBiometric, type BiometricThresholds } from '../domain/biometric.js';

export interface VerifyBiometricCommand {
  readonly qrSignedToken: string;
  readonly captureRef: string;
  /** The check-in officer's agency (from their verified token). */
  readonly actorAgency: Agency;
  readonly context: EventContext;
}

export type VerifyBiometricOutcome =
  | {
      readonly kind: 'EVALUATED';
      readonly sessionId: string;
      readonly applicantId: string;
      readonly verified: boolean;
      readonly livenessPass: boolean;
      readonly faceMatchPass: boolean;
    }
  /** The QR failed signature/expiry verification — not a valid invitation. */
  | { readonly kind: 'INVALID_INVITATION' }
  /** The QR belongs to a different agency than the officer performing check-in. */
  | { readonly kind: 'AGENCY_MISMATCH'; readonly invitationAgency: Agency };

export interface VerifyBiometricDeps {
  readonly matcher: BiometricMatcher;
  readonly qrInvitationPublicKeyPem: string;
  readonly thresholds: BiometricThresholds;
  readonly eventBus: EventBus;
}

export class VerifyBiometricService {
  constructor(private readonly deps: VerifyBiometricDeps) {}

  async verify(command: VerifyBiometricCommand): Promise<VerifyBiometricOutcome> {
    const claims = verifySlotInvitation(this.deps.qrInvitationPublicKeyPem, command.qrSignedToken);
    if (claims === null) return { kind: 'INVALID_INVITATION' };
    if (claims.agency !== command.actorAgency) {
      return { kind: 'AGENCY_MISMATCH', invitationAgency: claims.agency };
    }

    const scores = await this.deps.matcher.match({
      captureRef: command.captureRef,
      applicantId: claims.applicantId,
    });
    const decision = evaluateBiometric(scores, this.deps.thresholds);
    const sessionId = randomUUID();

    const result: BiometricVerificationCompletedEvent = {
      ...newEnvelope(command.context),
      eventType: 'BIOMETRIC_VERIFICATION_COMPLETED',
      applicantId: claims.applicantId,
      sessionId,
      livenessScore: scores.livenessScore,
      livenessPass: decision.livenessPass,
      faceMatchConfidence: scores.faceMatchConfidence,
      faceMatchPass: decision.faceMatchPass,
    };
    await this.deps.eventBus.publish(result);

    const audit: AuditEvent = {
      ...newEnvelope(command.context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICANT',
      entityId: claims.applicantId,
      action: 'BIOMETRIC_VERIFICATION',
      performedBy: 'biometric-service',
      agency: claims.agency,
      metadata: { sessionId, verified: decision.verified, livenessPass: decision.livenessPass, faceMatchPass: decision.faceMatchPass },
    };
    await this.deps.eventBus.publish(audit);

    return {
      kind: 'EVALUATED',
      sessionId,
      applicantId: claims.applicantId,
      verified: decision.verified,
      livenessPass: decision.livenessPass,
      faceMatchPass: decision.faceMatchPass,
    };
  }
}
