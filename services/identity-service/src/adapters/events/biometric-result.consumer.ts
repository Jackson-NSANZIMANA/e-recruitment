// ══════════════════════════════════════════════════════════════════
// identity-service — BIOMETRIC_VERIFICATION_COMPLETED consumer
//
// identity-service's first consuming ingress (it was a pure producer). Records
// the exam-day biometric outcome onto the applicant identity. Consumer group
// `identity-service` on biometric.result. A persistence fault PROPAGATES →
// offset uncommitted → redelivery (the record is an idempotent UPDATE).
// ══════════════════════════════════════════════════════════════════

import { KAFKA_TOPICS } from '@usrp/shared-types';
import type { EventBus, EventHandler } from '@usrp/shared-events';
import type { ProjectBiometricResultService } from '../../application/project-biometric-result.service.js';

export const IDENTITY_BIOMETRIC_GROUP = 'identity-service';

export async function startBiometricResultConsumer(
  eventBus: EventBus,
  service: ProjectBiometricResultService,
): Promise<void> {
  const handler: EventHandler = async (event) => {
    if (event.eventType !== 'BIOMETRIC_VERIFICATION_COMPLETED') return;

    const outcome = await service.project({
      applicantId: event.applicantId,
      sessionId: event.sessionId,
      livenessPass: event.livenessPass,
      faceMatchPass: event.faceMatchPass,
      faceMatchConfidence: event.faceMatchConfidence,
    });

    console.log(
      JSON.stringify({
        msg: 'biometric_result_recorded',
        applicantId: event.applicantId,
        sessionId: event.sessionId,
        verified: event.livenessPass && event.faceMatchPass,
        outcome,
        correlationId: event.correlationId,
      }),
    );
  };

  await eventBus.subscribe([KAFKA_TOPICS.BIOMETRIC_RESULT], IDENTITY_BIOMETRIC_GROUP, handler);
}
