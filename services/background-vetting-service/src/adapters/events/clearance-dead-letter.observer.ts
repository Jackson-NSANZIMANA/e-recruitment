// ══════════════════════════════════════════════════════════════════
// background-vetting-service — the last word on a clearance event we gave up on
//
// THE HOLE THIS CLOSES (evaluation D2). The retry budget for a consumed event is
// six attempts over ~15.5 s, deliberately short so one stuck event cannot hold
// its partition hostage. A registry outage longer than that parks the event on
// `events.dead-letter` — recoverable by an operator, but for the citizen it is
// simply gone: `clearance_certificate_verifications` keeps its PENDING row, the
// checklist keeps saying "we are verifying", and no human is ever asked to look.
//
// A RE-DRIVE IS IMPOSSIBLE FROM DURABLE STATE, BY DESIGN. The certificate
// number is never stored (only an HMAC and its last 4), so a timer cannot
// reconstruct the registry call — and keeping the number to enable one would
// trade a citizen's privacy for our convenience. The terminal outcome therefore
// has to be a human, not another attempt: escalate to REVIEW/CLEARANCE_UNVERIFIED
// so the case lands in the amber queue and the citizen is told an officer will
// look. The number is still in hand here because this callback runs in the same
// process, with the event that failed.
//
// ONLY A REGISTRY OUTAGE IS ESCALATED, and that narrowness is the safety
// argument, not caution: `ClearanceRegistryUnavailableError` is thrown on the one
// path that has recorded nothing but PENDING. Any other terminal failure (a
// publish that failed AFTER a CLEARED verdict was recorded, say) may already have
// written a real verdict, and layering a REVIEW on top of it would regress a
// citizen who is already cleared. rls/0044 refuses that at the engine too.
// ══════════════════════════════════════════════════════════════════

import { logInfo, logWarn } from '@usrp/shared-logging';
import { deriveContext, type DeadLetterObserver } from '@usrp/shared-events';
import type { VerifyClearanceCertificateService } from '../../application/verify-clearance-certificate.service.js';
import { ClearanceRegistryUnavailableError } from '../../domain/clearance.types.js';
import { CLEARANCE_CONSUMER_GROUP } from './clearance-certificate-submitted.consumer.js';

/**
 * The observer for the clearance consumer group. Registered on the bus, so it
 * runs for every event THIS service dead-letters — including the ones it has no
 * business acting on, which are ignored by type.
 */
export function clearanceDeadLetterObserver(
  service: VerifyClearanceCertificateService,
): DeadLetterObserver {
  return async (event, info): Promise<void> => {
    // Another consumer in this process may share the bus: only answer for our
    // own group, and only for the one event type this service handles.
    if (info.groupId !== CLEARANCE_CONSUMER_GROUP) return;
    if (event.eventType !== 'CLEARANCE_CERTIFICATE_SUBMITTED') return;

    if (!(info.error instanceof ClearanceRegistryUnavailableError)) {
      // Not the outage path: the durable record may already hold a verdict, so
      // there is nothing safe to assert here. The park and the alarm stand.
      logWarn('clearance_dead_letter_not_escalated', {
        applicationId: event.applicationId,
        agency: event.agency,
        reason: info.reason,
        attempts: info.attempts,
      });
      return;
    }

    const outcome = await service.escalateUnverified({
      applicantId: event.applicantId,
      applicationId: event.applicationId,
      agency: event.agency,
      category: event.category,
      clearanceCertificateNumber: event.clearanceCertificateNumber,
      context: deriveContext(event),
    });

    // Info, not error: the outage itself was already logged as an error by the
    // bus and by the failing attempt. This line is the resolution of it.
    logInfo('clearance_verification_escalated', {
      applicationId: event.applicationId,
      agency: event.agency,
      outcome: outcome.kind,
      attempts: info.attempts,
      correlationId: event.correlationId,
    });
  };
}
