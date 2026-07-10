// ══════════════════════════════════════════════════════════════════
// notification-service — SLOT_ASSIGNED consumer (the only ingress)
//
// Subscribes the consumer group `notification-service` to slot.assigned. On
// each assignment it delivers the exam-slot invitation (the signed QR) and
// emits NOTIFICATION_DELIVERED. Its own consumer group — distinct from
// application-service's slot projection group — so both react to the same
// topic independently (delivery vs state projection). A delivery/publish fault
// PROPAGATES → offset uncommitted → redelivery (re-delivery is idempotent at
// the projection: NO_CHANGE once PHYSICAL_TEST_SCHEDULED).
// ══════════════════════════════════════════════════════════════════

import { KAFKA_TOPICS } from '@usrp/shared-types';
import { deriveContext, type EventBus, type EventHandler } from '@usrp/shared-events';
import type { DeliverInvitationService } from '../../application/deliver-invitation.service.js';

export const NOTIFICATION_CONSUMER_GROUP = 'notification-service';

export async function startSlotAssignedConsumer(
  eventBus: EventBus,
  service: DeliverInvitationService,
): Promise<void> {
  const handler: EventHandler = async (event) => {
    if (event.eventType !== 'SLOT_ASSIGNED') return; // single-type topic; stay defensive

    const outcome = await service.deliver({
      applicantId: event.applicantId,
      applicationId: event.applicationId,
      agency: event.agency,
      content: {
        venueName: event.venueName,
        examDate: event.examDate,
        reportingTimeHour: event.reportingTimeHour,
        qrSignedToken: event.qrSignedToken,
      },
      context: deriveContext(event),
    });

    console.log(
      JSON.stringify({
        msg: 'slot_invitation_delivered',
        applicationId: event.applicationId,
        agency: event.agency,
        channel: outcome.channel,
        deliveryStatus: outcome.deliveryStatus,
        correlationId: event.correlationId,
      }),
    );
  };

  await eventBus.subscribe([KAFKA_TOPICS.SLOT_ASSIGNED], NOTIFICATION_CONSUMER_GROUP, handler);
}
