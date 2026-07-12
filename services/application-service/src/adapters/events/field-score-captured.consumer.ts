// ══════════════════════════════════════════════════════════════════
// application-service — FIELD_SCORE_CAPTURED consumer (state-projection ingress)
//
// The application aggregate's FIFTH ingress. Subscribes field.score.captured
// (emitted by field-sync-service) and advances PHYSICAL_TEST_SCHEDULED →
// PHYSICAL_TEST_COMPLETE, enforcing the biometric-pass precondition.
//
// Its OWN consumer group, distinct from every other application-service
// consumer: consumer-group identity is the unit of partition assignment +
// offset tracking, not of state ownership. A different topic set
// (field.score.captured) MUST NOT share a group with consumers on other topics
// — the shared-group / perpetual-rebalance defect (see the pipeline fix). A
// projection fault PROPAGATES → offset uncommitted → redelivery (re-projection
// is a no-op once PHYSICAL_TEST_COMPLETE).
// ══════════════════════════════════════════════════════════════════

import { KAFKA_TOPICS } from '@usrp/shared-types';
import { deriveContext, type EventBus, type EventHandler } from '@usrp/shared-events';
import type { ProjectPhysicalTestCompleteService } from '../../application/project-physical-test-complete.service.js';

/** Own consumer group for the physical-test projection — distinct from all others. */
export const APPLICATION_PHYSICAL_TEST_PROJECTION_GROUP = 'application-service-physical-test';

export async function startFieldScoreCapturedConsumer(
  eventBus: EventBus,
  service: ProjectPhysicalTestCompleteService,
): Promise<void> {
  const handler: EventHandler = async (event) => {
    if (event.eventType !== 'FIELD_SCORE_CAPTURED') return; // single-type topic; stay defensive

    const outcome = await service.project({
      result: {
        applicationId: event.applicationId,
        agency: event.agency,
        signedPayloadHash: event.signedPayloadHash,
        correlationId: event.correlationId,
      },
      agency: event.agency,
      context: deriveContext(event),
    });

    console.log(
      JSON.stringify({
        msg: 'physical_test_capture_projected',
        applicationId: event.applicationId,
        agency: event.agency,
        deviceId: event.deviceId,
        outcome: outcome.kind,
        ...(outcome.kind === 'APPLIED'
          ? { fromStatus: outcome.fromStatus, toStatus: outcome.toStatus }
          : {}),
        correlationId: event.correlationId,
      }),
    );
  };

  await eventBus.subscribe(
    [KAFKA_TOPICS.FIELD_SCORE_CAPTURED],
    APPLICATION_PHYSICAL_TEST_PROJECTION_GROUP,
    handler,
  );
}
