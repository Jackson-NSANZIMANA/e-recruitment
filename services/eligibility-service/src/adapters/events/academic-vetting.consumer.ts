// ══════════════════════════════════════════════════════════════════
// eligibility-service — APPLICANT_SUBMITTED consumer (academic vetting ingress)
//
// The academic gate's event-driven counterpart to its HTTP controllers. When an
// applicant submits, the NESA (A-Level) or HEC (degree) gate runs automatically
// off the backbone — the same way age and criminal already do — so the
// academic verdict reaches the application-state projection without any
// synchronous call. Without this, academic_status stays PENDING forever and the
// projection can never reach the positive terminal (DOCUMENT_REVIEW_GREEN).
//
// ROUTING: the front door resolves exactly one academic credential per category
// (EDUCATION_REQUIREMENTS), so APPLICANT_SUBMITTED carries EITHER nesaIndexNumber
// (A-Level path) XOR hecRegistrationNumber (degree path). We route on which one
// is present — never guess from the category a second time.
//
// OWN CONSUMER GROUP (`eligibility-academic`), deliberately SEPARATE from the age
// gate's group. Age is a pure internal computation; the academic gate calls an
// external G2G authority (NESA/HEC) that can be unavailable. Isolating the groups
// means a NESA/HEC outage retries ONLY the academic reaction — it never forces
// the (already-succeeded) age gate to re-run. Both gates still react to the same
// trigger in parallel, coupled only by the backbone.
//
// FAIL vs FAULT: a G2G outage (NesaUnavailableError / HecUnavailableError)
// PROPAGATES out of the handler → the offset is not committed → redelivery, so a
// transient outage retries rather than dropping a required academic check. A
// business outcome (applicant unknown / not verified / record-not-found) is a
// RETURN VALUE — the gate has already emitted its (fail-closed) verdict event, so
// we log and let the offset commit. Record-not-found emits an INELIGIBLE
// completion event, so a missing record REJECTS downstream, never silently stalls.
// ══════════════════════════════════════════════════════════════════

import { KAFKA_TOPICS } from '@usrp/shared-types';
import { deriveContext, type EventBus, type EventHandler } from '@usrp/shared-events';
import type { VerifyNesaEducationService } from '../../application/verify-nesa-education.service.js';
import type { VerifyHecEducationService } from '../../application/verify-hec-education.service.js';

export const ACADEMIC_CONSUMER_GROUP = 'eligibility-academic';

export interface AcademicVettingServices {
  readonly education: VerifyNesaEducationService; // NESA A-Level path
  readonly degree: VerifyHecEducationService; // HEC degree path
}

/**
 * Subscribe the academic gate to the applicant.submitted topic, routing each
 * submission to NESA or HEC by the credential the event carries. Idempotent in
 * effect: re-processing re-runs the gate over a fresh G2G call and re-emits;
 * downstream dedupes by kafkaEventId (audit) / is a pure projection (app-state).
 */
export async function startAcademicVettingConsumer(
  eventBus: EventBus,
  services: AcademicVettingServices,
): Promise<void> {
  const handler: EventHandler = async (event) => {
    if (event.eventType !== 'APPLICANT_SUBMITTED') return; // topic is single-type, but stay defensive

    // Preserve the trace: same correlationId, caused by THIS submitted event.
    const context = deriveContext(event);

    if (event.nesaIndexNumber !== null) {
      const outcome = await services.education.verify({
        applicantId: event.applicantId,
        applicationId: event.applicationId,
        category: event.category,
        nesaIndexNumber: event.nesaIndexNumber,
        context,
      });
      console.log(
        JSON.stringify({
          msg: 'academic_vetted',
          path: 'NESA',
          applicantId: event.applicantId,
          applicationId: event.applicationId,
          category: event.category,
          outcome: outcome.kind,
          correlationId: event.correlationId,
        }),
      );
      return;
    }

    if (event.hecRegistrationNumber !== null) {
      const outcome = await services.degree.verify({
        applicantId: event.applicantId,
        applicationId: event.applicationId,
        category: event.category,
        hecRegistrationNumber: event.hecRegistrationNumber,
        context,
      });
      console.log(
        JSON.stringify({
          msg: 'academic_vetted',
          path: 'HEC',
          applicantId: event.applicantId,
          applicationId: event.applicationId,
          category: event.category,
          outcome: outcome.kind,
          correlationId: event.correlationId,
        }),
      );
      return;
    }

    // Neither credential present — the front door guarantees exactly one, so this
    // is a contract violation, not an expected path. Log and skip (committing the
    // offset); do not throw and spin on redelivery for a malformed submission.
    console.error(
      JSON.stringify({
        msg: 'academic_vetting_skipped_no_credential',
        applicantId: event.applicantId,
        applicationId: event.applicationId,
        category: event.category,
        correlationId: event.correlationId,
      }),
    );
  };

  await eventBus.subscribe([KAFKA_TOPICS.APPLICANT_SUBMITTED], ACADEMIC_CONSUMER_GROUP, handler);
}
