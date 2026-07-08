// ══════════════════════════════════════════════════════════════════
// application-service — Vetting-result consumer (state-projection ingress)
//
// The application aggregate's SECOND ingress. Where the HTTP front door CREATES
// an application, this consumer ADVANCES it: it subscribes to the three vetting
// result topics — vetting.nesa, vetting.hec, vetting.rib — that no service
// consumed before, and projects each verdict onto the application row.
//
// It runs in its OWN consumer group (`application-service`). All events for one
// applicant share a partition (keyed by applicantId), so an applicant's verdicts
// are delivered in order to a single consumer — the projection never races
// itself on one row.
//
// A projection fault PROPAGATES: the bus leaves the offset uncommitted and the
// verdict is redelivered. Re-projection is safe — the repository is idempotent
// (NO_CHANGE on an already-applied verdict).
// ══════════════════════════════════════════════════════════════════

import { KAFKA_TOPICS } from '@usrp/shared-types';
import { deriveContext, type EventBus, type EventHandler } from '@usrp/shared-events';
import type { VettingResult } from '../../ports/application-repository.js';
import type { ProjectVettingResultService } from '../../application/project-vetting-result.service.js';

export const APPLICATION_PROJECTION_GROUP = 'application-service';

/**
 * Subscribe the projection use case to the three vetting result topics. Each
 * event carries applicationId + agency + verdict — everything the projection
 * needs; no DB read of identity is required here.
 */
export async function startVettingResultConsumer(
  eventBus: EventBus,
  service: ProjectVettingResultService,
): Promise<void> {
  const handler: EventHandler = async (event) => {
    let result: VettingResult;

    switch (event.eventType) {
      case 'NESA_VERIFICATION_COMPLETED':
        result = {
          dimension: 'ACADEMIC',
          applicationId: event.applicationId,
          agency: event.agency,
          academicStatus: event.academicStatus,
          verifiedVia: 'NESA',
          requestId: event.nesaRequestId,
          detail: event.eligibilityResult,
          correlationId: event.correlationId,
        };
        break;
      case 'HEC_VERIFICATION_COMPLETED':
        result = {
          dimension: 'ACADEMIC',
          applicationId: event.applicationId,
          agency: event.agency,
          academicStatus: event.academicStatus,
          verifiedVia: 'HEC',
          requestId: event.hecRequestId,
          detail: event.eligibilityResult,
          correlationId: event.correlationId,
        };
        break;
      case 'RIB_VETTING_COMPLETED':
        result = {
          dimension: 'CRIMINAL',
          applicationId: event.applicationId,
          agency: event.agency,
          criminalStatus: event.clearanceStatus,
          appliedThreshold: event.appliedThreshold,
          ribRequestId: event.ribRequestId,
          correlationId: event.correlationId,
        };
        break;
      default:
        return; // not a vetting result — the three topics are single-type each
    }

    const outcome = await service.project({
      result,
      agency: event.agency,
      context: deriveContext(event),
    });

    console.log(
      JSON.stringify({
        msg: 'vetting_result_projected',
        eventType: event.eventType,
        applicationId: result.applicationId,
        agency: event.agency,
        outcome: outcome.kind,
        ...(outcome.kind === 'APPLIED'
          ? { fromStatus: outcome.fromStatus, toStatus: outcome.toStatus }
          : {}),
        correlationId: event.correlationId,
      }),
    );
  };

  await eventBus.subscribe(
    [KAFKA_TOPICS.VETTING_NESA, KAFKA_TOPICS.VETTING_HEC, KAFKA_TOPICS.VETTING_RIB],
    APPLICATION_PROJECTION_GROUP,
    handler,
  );
}
