// ══════════════════════════════════════════════════════════════════
// scheduling-service — APPLICATION_ELIGIBILITY_CLEARED consumer (the only ingress)
//
// Scheduling has no synchronous HTTP surface: it runs entirely off the backbone.
// When application-service's projection advances an application to the positive
// eligibility terminal (DOCUMENT_REVIEW_GREEN), it emits
// APPLICATION_ELIGIBILITY_CLEARED; this consumer reacts by assigning an exam
// slot. Its OWN consumer group (`scheduling-service`) sees every clearance
// independently of any other reactor.
//
// A SchedulingReadError (DB fault) from the use case PROPAGATES: the bus does not
// commit the offset and the event is redelivered — a transient DB outage retries
// rather than silently dropping a required slot assignment. Business outcomes
// (NO_VENUE / APPLICANT_NOT_FOUND) are logged and committed.
// ══════════════════════════════════════════════════════════════════

import { KAFKA_TOPICS } from '@usrp/shared-types';
import { deriveContext, type EventBus, type EventHandler } from '@usrp/shared-events';
import type { AssignSlotService } from '../../application/assign-slot.service.js';

export const SCHEDULING_CONSUMER_GROUP = 'scheduling-service';

export async function startApplicationClearedConsumer(
  eventBus: EventBus,
  service: AssignSlotService,
): Promise<void> {
  const handler: EventHandler = async (event) => {
    if (event.eventType !== 'APPLICATION_ELIGIBILITY_CLEARED') return; // topic is single-type, but stay defensive

    const outcome = await service.assign({
      applicationId: event.applicationId,
      applicantId: event.applicantId,
      agency: event.agency,
      campaignId: event.campaignId,
      // Preserve the trace: same correlationId, caused by THIS cleared event.
      context: deriveContext(event),
    });

    console.log(
      JSON.stringify({
        msg: 'slot_assignment_processed',
        applicationId: event.applicationId,
        agency: event.agency,
        outcome: outcome.kind,
        correlationId: event.correlationId,
      }),
    );
  };

  await eventBus.subscribe([KAFKA_TOPICS.APPLICATION_CLEARED], SCHEDULING_CONSUMER_GROUP, handler);
}
