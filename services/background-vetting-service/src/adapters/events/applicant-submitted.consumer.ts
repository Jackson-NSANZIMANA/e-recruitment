// ══════════════════════════════════════════════════════════════════
// background-vetting-service — APPLICANT_SUBMITTED consumer (the only ingress)
//
// Criminal vetting has no synchronous HTTP surface: it runs entirely off the
// event backbone. When an applicant submits (choosing an agency + category),
// the RIB gate runs automatically — no service calls it directly.
//
// APPLICANT_SUBMITTED is the right trigger: it carries the internal
// `nationalIdHash` (RIB's lookup key) AND the `category` (which fixes the
// conviction threshold) AND the `applicationId` (which the verdict is bound
// to). It is produced ONLY for a VERIFIED applicant by the front door, so
// this service needs no identity read of its own — it is DB-free.
//
// It runs in its OWN consumer group (`background-vetting-service`), so it sees
// every submission independently of the age gate's group — the two gates react
// to the same trigger in parallel, coupled only by the backbone.
//
// A RibUnavailableError from the use case PROPAGATES: the bus does not commit
// the offset, and the event is redelivered — a transient RIB outage retries
// rather than silently dropping a required criminal check.
// ══════════════════════════════════════════════════════════════════

import { KAFKA_TOPICS } from '@usrp/shared-types';
import { deriveContext, type EventBus, type EventHandler } from '@usrp/shared-events';
import type { VerifyCriminalClearanceService } from '../../application/verify-criminal-clearance.service.js';

export const BACKGROUND_VETTING_CONSUMER_GROUP = 'background-vetting-service';

/**
 * Subscribe the criminal-clearance use case to the applicant.submitted topic.
 * Idempotent in effect: re-processing a submitted event re-runs the (pure)
 * evaluation over a fresh RIB call and re-emits — downstream consumers dedupe
 * by kafkaEventId (the audit sink) / are pure projections (any RIB projector).
 */
export async function startApplicantSubmittedConsumer(
  eventBus: EventBus,
  service: VerifyCriminalClearanceService,
): Promise<void> {
  const handler: EventHandler = async (event) => {
    if (event.eventType !== 'APPLICANT_SUBMITTED') return; // topic is single-type, but stay defensive

    const outcome = await service.verify({
      applicantId: event.applicantId,
      applicationId: event.applicationId,
      category: event.category,
      nationalIdHash: event.nationalIdHash,
      // Preserve the trace: same correlationId, caused by THIS submitted event.
      context: deriveContext(event),
    });

    console.log(
      JSON.stringify({
        msg: 'criminal_clearance_vetted',
        applicantId: event.applicantId,
        applicationId: event.applicationId,
        category: event.category,
        clearanceStatus: outcome.decision.clearanceStatus,
        appliedThreshold: outcome.decision.appliedThreshold,
        ribRequestId: outcome.ribRequestId,
        correlationId: event.correlationId,
      }),
    );
  };

  await eventBus.subscribe(
    [KAFKA_TOPICS.APPLICANT_SUBMITTED],
    BACKGROUND_VETTING_CONSUMER_GROUP,
    handler,
  );
}
