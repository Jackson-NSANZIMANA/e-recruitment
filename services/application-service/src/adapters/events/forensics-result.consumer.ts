// ══════════════════════════════════════════════════════════════════
// application-service — Forensics-result consumer (amber-lane routing ingress)
//
// Subscribes to document.forensics and routes each verdict's LANE onto the
// application row. Runs in its OWN consumer group — the hard platform rule
// since the pipeline-convergence defect: two members of one Kafka group with
// divergent topic subscriptions can never stabilize, so every new projection
// gets a dedicated group. Events are partition-keyed by applicationId, so one
// application's verdicts arrive in order to a single consumer.
//
// A projection fault PROPAGATES: the bus leaves the offset uncommitted and
// the verdict is redelivered. Safe — the repository is idempotent.
// ══════════════════════════════════════════════════════════════════

import { KAFKA_TOPICS } from '@usrp/shared-types';
import { deriveContext, type EventBus, type EventHandler } from '@usrp/shared-events';
import type { ProjectForensicsResultService } from '../../application/project-forensics-result.service.js';

export const APPLICATION_FORENSICS_PROJECTION_GROUP = 'application-service-forensics';

export async function startForensicsResultConsumer(
  eventBus: EventBus,
  service: ProjectForensicsResultService,
): Promise<void> {
  const handler: EventHandler = async (event) => {
    if (event.eventType !== 'DOCUMENT_FORENSICS_COMPLETED') return;

    const outcome = await service.project({
      result: {
        applicationId: event.applicationId,
        agency: event.agency,
        lane: event.lane,
        documentId: event.documentId,
        correlationId: event.correlationId,
      },
      agency: event.agency,
      context: deriveContext(event),
    });

    console.log(
      JSON.stringify({
        msg: 'forensics_result_projected',
        applicationId: event.applicationId,
        agency: event.agency,
        lane: event.lane,
        outcome: outcome.kind,
        ...(outcome.kind === 'APPLIED'
          ? { fromStatus: outcome.fromStatus, toStatus: outcome.toStatus }
          : {}),
        correlationId: event.correlationId,
      }),
    );
  };

  await eventBus.subscribe(
    [KAFKA_TOPICS.DOCUMENT_FORENSICS],
    APPLICATION_FORENSICS_PROJECTION_GROUP,
    handler,
  );
}
