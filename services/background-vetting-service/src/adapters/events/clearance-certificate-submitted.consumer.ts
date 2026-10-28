// ══════════════════════════════════════════════════════════════════
// background-vetting-service — CLEARANCE_CERTIFICATE_SUBMITTED consumer
//
// Ingress of the Irembo certificate flow (ADR-048 §2.3). Its OWN consumer
// group, so a registry outage retries only this reaction.
//
// A ClearanceRegistryUnavailableError PROPAGATES: the offset is not committed
// and the event is redelivered, so an outage is retried and never becomes a
// verdict. A business outcome (correctable failure, review, cleared) is a
// RETURN VALUE: the use case has already recorded and emitted it.
// ══════════════════════════════════════════════════════════════════

import { logInfo } from '@usrp/shared-logging';
import { KAFKA_TOPICS } from '@usrp/shared-types';
import { deriveContext, type EventBus, type EventHandler } from '@usrp/shared-events';
import type { VerifyClearanceCertificateService } from '../../application/verify-clearance-certificate.service.js';

export const CLEARANCE_CONSUMER_GROUP = 'background-vetting-clearance';

export async function startClearanceCertificateConsumer(
  eventBus: EventBus,
  service: VerifyClearanceCertificateService,
): Promise<void> {
  const handler: EventHandler = async (event) => {
    if (event.eventType !== 'CLEARANCE_CERTIFICATE_SUBMITTED') return;
    const outcome = await service.verify({
      applicantId: event.applicantId,
      applicationId: event.applicationId,
      agency: event.agency,
      category: event.category,
      clearanceCertificateNumber: event.clearanceCertificateNumber,
      referenceDate: event.referenceDate,
      context: deriveContext(event),
    });
    logInfo('clearance_certificate_verified', {
      applicationId: event.applicationId,
      agency: event.agency,
      outcome: outcome.kind,
      ...('code' in outcome ? { code: outcome.code } : {}),
      correlationId: event.correlationId,
    });
  };
  await eventBus.subscribe([KAFKA_TOPICS.CLEARANCE_SUBMITTED], CLEARANCE_CONSUMER_GROUP, handler);
}
