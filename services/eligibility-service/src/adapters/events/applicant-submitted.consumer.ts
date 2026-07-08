// ══════════════════════════════════════════════════════════════════
// eligibility-service — APPLICANT_SUBMITTED consumer (event-driven ingress)
//
// The async counterpart to the HTTP controller. When an applicant submits
// (choosing an agency + category), the age gate runs automatically off the
// event backbone — no synchronous call from another service. Carries the
// causal chain forward: the emitted AUDIT_ENTRY's causationId is the
// submitted event's id, so the whole decision is traceable end-to-end.
//
// APPLICANT_SUBMITTED is the right trigger (not NIDA_VERIFICATION_COMPLETED):
// it carries the chosen `category`, which the age band requires. The
// use-case still guards that the identity is VERIFIED before evaluating.
// ══════════════════════════════════════════════════════════════════

import { KAFKA_TOPICS } from '@usrp/shared-types';
import { deriveContext, type EventBus, type EventHandler } from '@usrp/shared-events';
import type { EvaluateAgeEligibilityService } from '../../application/evaluate-age-eligibility.service.js';

export const ELIGIBILITY_CONSUMER_GROUP = 'eligibility-service';

/**
 * Subscribe the age-eligibility use case to the applicant.submitted topic.
 * Idempotent per event at least in effect: re-processing a submitted event
 * for an already-created identity simply re-evaluates the (pure) age gate.
 */
export async function startApplicantSubmittedConsumer(
  eventBus: EventBus,
  service: EvaluateAgeEligibilityService,
): Promise<void> {
  const handler: EventHandler = async (event) => {
    if (event.eventType !== 'APPLICANT_SUBMITTED') return; // topic is single-type, but stay defensive

    const outcome = await service.evaluate({
      applicantId: event.applicantId,
      category: event.category,
      // The submitted event carries the filed applicationId → the age gate emits
      // an applicationId-bearing AGE_ELIGIBILITY_COMPLETED the projection can land.
      applicationId: event.applicationId,
      // Preserve the trace: same correlationId, caused by THIS submitted event.
      context: deriveContext(event),
    });

    console.log(
      JSON.stringify({
        msg: 'applicant_submitted_processed',
        applicantId: event.applicantId,
        category: event.category,
        outcome: outcome.kind,
        correlationId: event.correlationId,
      }),
    );
  };

  await eventBus.subscribe([KAFKA_TOPICS.APPLICANT_SUBMITTED], ELIGIBILITY_CONSUMER_GROUP, handler);
}
