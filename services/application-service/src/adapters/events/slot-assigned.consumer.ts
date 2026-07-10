// ══════════════════════════════════════════════════════════════════
// application-service — Slot-assigned consumer (state-projection ingress)
//
// The application aggregate's THIRD ingress (front door CREATES, vetting
// projection ADVANCES through eligibility, this STAMPS the exam slot). It
// subscribes to slot.assigned — emitted by scheduling-service after it resolves
// the applicant's home district to a venue — and projects the assignment onto
// the application row, advancing DOCUMENT_REVIEW_GREEN → SLOT_ASSIGNED.
//
// It runs in its OWN consumer group, SEPARATE from the vetting projection. Both
// belong to application-service and write the same rows — but consumer-group
// identity is the unit of partition assignment + offset tracking, NOT of state
// ownership. Two consumers in one group subscribing to DIFFERENT topic sets
// (vetting.* vs slot.assigned) can never stabilise their assignment → the group
// rebalances perpetually and starves both. (This was a real defect: it made the
// full pipeline non-convergent once this second consumer was added; the vetting
// and slot proofs pass in isolation because each runs only one of them.) A shared
// group also buys nothing here — slot.assigned and vetting.* are different topics,
// hence different partitions, so it never provided cross-topic ordering. A
// projection fault PROPAGATES → offset uncommitted → redelivery (re-projection is
// a no-op once SLOT_ASSIGNED).
// ══════════════════════════════════════════════════════════════════

import { KAFKA_TOPICS } from '@usrp/shared-types';
import { deriveContext, type EventBus, type EventHandler } from '@usrp/shared-events';
import type { ProjectSlotAssignmentService } from '../../application/project-slot-assignment.service.js';

/** Own consumer group for the slot projection — distinct from the vetting group. */
export const APPLICATION_SLOT_PROJECTION_GROUP = 'application-service-slot';

/**
 * Subscribe the slot-assignment projection to the slot.assigned topic, in its own
 * consumer group (see the file header for why it must NOT share the vetting group).
 */
export async function startSlotAssignedConsumer(
  eventBus: EventBus,
  service: ProjectSlotAssignmentService,
): Promise<void> {
  const handler: EventHandler = async (event) => {
    if (event.eventType !== 'SLOT_ASSIGNED') return; // topic is single-type, but stay defensive

    const outcome = await service.project({
      result: {
        applicationId: event.applicationId,
        agency: event.agency,
        venueAssignmentId: event.slotId,
        assignedDistrict: event.district,
        assignedVenueName: event.venueName,
        examDate: event.examDate,
        qrInvitationCode: event.qrInvitationCode,
        correlationId: event.correlationId,
      },
      agency: event.agency,
      context: deriveContext(event),
    });

    console.log(
      JSON.stringify({
        msg: 'slot_assignment_projected',
        applicationId: event.applicationId,
        agency: event.agency,
        outcome: outcome.kind,
        ...(outcome.kind === 'APPLIED' ? { fromStatus: outcome.fromStatus, toStatus: outcome.toStatus } : {}),
        correlationId: event.correlationId,
      }),
    );
  };

  await eventBus.subscribe([KAFKA_TOPICS.SLOT_ASSIGNED], APPLICATION_SLOT_PROJECTION_GROUP, handler);
}
