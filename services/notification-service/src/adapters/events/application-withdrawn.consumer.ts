// ══════════════════════════════════════════════════════════════════
// notification-service — APPLICATION_WITHDRAWN consumer (ADR-022 ingress)
//
// Subscribes the withdrawal-notice use case to application.withdrawn (the
// per-acceptance summary the ADR-017 projector emits). Its OWN consumer
// group, distinct from the slot-invitation group — one group per topic-set
// per service (the shared-group / perpetual-rebalance defect). A delivery
// fault propagates → offset uncommitted → redelivery.
// ══════════════════════════════════════════════════════════════════

import { KAFKA_TOPICS } from '@usrp/shared-types';
import { deriveContext, type EventBus, type EventHandler } from '@usrp/shared-events';
import type { DeliverWithdrawalNoticeService } from '../../application/deliver-withdrawal-notice.service.js';

/** Own consumer group for the withdrawal notice — distinct from the invitation group. */
export const WITHDRAWAL_NOTICE_CONSUMER_GROUP = 'notification-service-withdrawal';

export async function startApplicationWithdrawnConsumer(
  eventBus: EventBus,
  service: DeliverWithdrawalNoticeService,
): Promise<void> {
  const handler: EventHandler = async (event) => {
    if (event.eventType !== 'APPLICATION_WITHDRAWN') return; // single-type topic; stay defensive

    const deliveryStatus = await service.deliver({
      applicantId: event.applicantId,
      acceptedApplicationId: event.acceptedApplicationId,
      acceptedByAgency: event.acceptedByAgency,
      withdrawn: event.withdrawn,
      context: deriveContext(event),
    });

    console.log(
      JSON.stringify({
        msg: 'withdrawal_notice_processed',
        applicantId: event.applicantId,
        acceptedByAgency: event.acceptedByAgency,
        withdrawnCount: event.withdrawn.length,
        deliveryStatus,
        correlationId: event.correlationId,
      }),
    );
  };

  await eventBus.subscribe(
    [KAFKA_TOPICS.APPLICATION_WITHDRAWN],
    WITHDRAWAL_NOTICE_CONSUMER_GROUP,
    handler,
  );
}
