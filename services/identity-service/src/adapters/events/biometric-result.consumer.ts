// ══════════════════════════════════════════════════════════════════
// identity-service — BIOMETRIC_VERIFICATION_COMPLETED consumer
//
// identity-service's first consuming ingress (it was a pure producer). Records
// the exam-day biometric outcome onto the applicant identity. Consumer group
// `identity-service` on biometric.result. v1.1 evidence events (ADR-037)
// are ignored: evidence never becomes a verdict on the identity. A persistence fault PROPAGATES →
// offset uncommitted → redelivery (the record is an idempotent UPDATE).
// ══════════════════════════════════════════════════════════════════

import { logInfo } from '@usrp/shared-logging';
import { KAFKA_TOPICS } from '@usrp/shared-types';
import type { BiometricVerificationCompletedEvent } from '@usrp/shared-types';
import type { EventBus, EventHandler } from '@usrp/shared-events';
import type { ProjectBiometricResultService } from '../../application/project-biometric-result.service.js';

export const IDENTITY_BIOMETRIC_GROUP = 'identity-service';

/**
 * ADR-037: a v1.1 event is device-attested identity EVIDENCE, never a
 * verdict. It must not set or clear biometric_verified_at (the physical-test
 * precondition reads that column), so only the legacy v1.0 server-side
 * check-in result is projected. PURE.
 */
export function isLegacyCheckInResult(event: BiometricVerificationCompletedEvent): boolean {
  return event.schemaVersion === undefined && event.recordId === undefined
    && event.method === undefined && event.mode === undefined;
}

export async function startBiometricResultConsumer(
  eventBus: EventBus,
  service: ProjectBiometricResultService,
): Promise<void> {
  const handler: EventHandler = async (event) => {
    if (event.eventType !== 'BIOMETRIC_VERIFICATION_COMPLETED') return;
    if (!isLegacyCheckInResult(event)) {
      logInfo('biometric_evidence_event_not_projected', {
        sessionId: event.sessionId,
        correlationId: event.correlationId,
      });
      return;
    }

    const outcome = await service.project({
      applicantId: event.applicantId,
      sessionId: event.sessionId,
      livenessPass: event.livenessPass,
      faceMatchPass: event.faceMatchPass,
      faceMatchConfidence: event.faceMatchConfidence,
    });

    logInfo('biometric_result_recorded', {
      applicantId: event.applicantId,
      sessionId: event.sessionId,
      verified: event.livenessPass && event.faceMatchPass,
      outcome,
      correlationId: event.correlationId,
    });
  };

  await eventBus.subscribe([KAFKA_TOPICS.BIOMETRIC_RESULT], IDENTITY_BIOMETRIC_GROUP, handler);
}
