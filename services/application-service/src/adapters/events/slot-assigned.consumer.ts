// ══════════════════════════════════════════════════════════════════
// application-service — Slot-assigned consumer (state-projection ingress)
//
// The application aggregate's THIRD ingress (front door CREATES, vetting
// projection ADVANCES through eligibility, this STAMPS the exam slot). It
// subscribes to slot.assigned — emitted by scheduling-service after it resolves
// the applicant's home district to a venue — and projects the assignment onto
// the application row, advancing DOCUMENT_REVIEW_GREEN → SLOT_ASSIGNED.
//
// It shares the application-service consumer group with the vetting projection;
// all events for one applicant share a partition (keyed by applicantId), so an
// applicant's assignment is delivered in order after its clearance. A projection
// fault PROPAGATES → offset uncommitted → redelivery (re-projection is a no-op
// once SLOT_ASSIGNED).
// ══════════════════════════════════════════════════════════════════

import { KAFKA_TOPICS } from '@usrp/shared-types';
import { deriveContext, type EventBus, type EventHandler } from '@usrp/shared-events';
import type { ProjectSlotAssignmentService } from '../../application/project-slot-assignment.service.js';
import { APPLICATION_PROJECTION_GROUP } from './vetting-result.consumer.js';

/**
 * Subscribe the slot-assignment projection to the slot.assigned topic. Runs in
 * the same application-service group as the vetting projection — one owner of
 * application state.
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

  await eventBus.subscribe([KAFKA_TOPICS.SLOT_ASSIGNED], APPLICATION_PROJECTION_GROUP, handler);
}
