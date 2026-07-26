// ══════════════════════════════════════════════════════════════════
// application-service — Application-accepted consumer (auto-withdrawal ingress)
//
// Subscribes to application.accepted — emitted by this same service's officer
// accept path — and drives the auto-withdrawal projection (ADR-017). Consuming
// our own event rather than calling the projection inline keeps the accept
// transaction small and officer-scoped (the officer's role cannot touch the
// sibling schemas anyway) and makes the withdrawal exactly as durable as every
// other projection: a fault propagates → offset uncommitted → redelivery, and
// re-projection after success is a no-op.
//
// Own consumer group — one group per topic-set per service (see the
// slot-assigned consumer header for the rebalance trap this avoids).
// ══════════════════════════════════════════════════════════════════

import { KAFKA_TOPICS } from '@usrp/shared-types';
import { deriveContext, type EventBus, type EventHandler } from '@usrp/shared-events';
import type { ProjectApplicationAcceptedService } from '../../application/project-application-accepted.service.js';

/** Own consumer group for the withdrawal projection. */
export const APPLICATION_WITHDRAWAL_PROJECTION_GROUP = 'application-service-withdrawal';

/** Subscribe the auto-withdrawal projection to application.accepted. */
export async function startApplicationAcceptedConsumer(
  eventBus: EventBus,
  service: ProjectApplicationAcceptedService,
): Promise<void> {
  const handler: EventHandler = async (event) => {
    if (event.eventType !== 'APPLICATION_ACCEPTED') return; // single-type topic; stay defensive

    const withdrawn = await service.project({
      applicantId: event.applicantId,
      acceptedApplicationId: event.applicationId,
      acceptedByAgency: event.agency,
      context: deriveContext(event),
    });

    console.log(
      JSON.stringify({
        msg: 'auto_withdrawal_projected',
        acceptedApplicationId: event.applicationId,
        acceptedByAgency: event.agency,
        withdrawnCount: withdrawn.length,
        withdrawn: withdrawn.map((w) => ({ applicationId: w.applicationId, agency: w.agency, fromStatus: w.fromStatus })),
        correlationId: event.correlationId,
      }),
    );
  };

  await eventBus.subscribe(
    [KAFKA_TOPICS.APPLICATION_ACCEPTED],
    APPLICATION_WITHDRAWAL_PROJECTION_GROUP,
    handler,
  );
}
