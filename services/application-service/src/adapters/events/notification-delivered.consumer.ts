// ══════════════════════════════════════════════════════════════════
// application-service — NOTIFICATION_DELIVERED consumer (state-projection ingress)
//
// The application aggregate's FOURTH ingress. Subscribes notification.delivered
// (emitted by notification-service) and advances SLOT_ASSIGNED →
// PHYSICAL_TEST_SCHEDULED, recording the SMS delivery status on the row.
//
// Its OWN consumer group, distinct from the vetting group and the slot group:
// consumer-group identity is the unit of partition assignment + offset
// tracking, not of state ownership. Different topic set (notification.delivered)
// → must not share a group with consumers on other topics (the shared-group /
// perpetual-rebalance defect). A projection fault PROPAGATES → offset
// uncommitted → redelivery (re-projection is a no-op once PHYSICAL_TEST_SCHEDULED).
// ══════════════════════════════════════════════════════════════════

import { KAFKA_TOPICS } from '@usrp/shared-types';
import { deriveContext, type EventBus, type EventHandler } from '@usrp/shared-events';
import type { ProjectNotificationDeliveryService } from '../../application/project-notification-delivery.service.js';

/** Own consumer group for the notification projection — distinct from vetting/slot. */
export const APPLICATION_NOTIFICATION_PROJECTION_GROUP = 'application-service-notification';

export async function startNotificationDeliveredConsumer(
  eventBus: EventBus,
  service: ProjectNotificationDeliveryService,
): Promise<void> {
  const handler: EventHandler = async (event) => {
    if (event.eventType !== 'NOTIFICATION_DELIVERED') return; // single-type topic; stay defensive

    const outcome = await service.project({
      result: {
        applicationId: event.applicationId,
        agency: event.agency,
        deliveryStatus: event.deliveryStatus,
        correlationId: event.correlationId,
      },
      agency: event.agency,
      context: deriveContext(event),
    });

    console.log(
      JSON.stringify({
        msg: 'notification_delivery_projected',
        applicationId: event.applicationId,
        agency: event.agency,
        deliveryStatus: event.deliveryStatus,
        outcome: outcome.kind,
        ...(outcome.kind === 'APPLIED' ? { fromStatus: outcome.fromStatus, toStatus: outcome.toStatus } : {}),
        correlationId: event.correlationId,
      }),
    );
  };

  await eventBus.subscribe(
    [KAFKA_TOPICS.NOTIFICATION_DELIVERED],
    APPLICATION_NOTIFICATION_PROJECTION_GROUP,
    handler,
  );
}
