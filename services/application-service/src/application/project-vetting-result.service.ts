// ══════════════════════════════════════════════════════════════════
// application-service — Project vetting result (use case)
//
// The second adapter over the application aggregate (the first is the HTTP
// front door). It takes ONE vetting verdict — academic (NESA/HEC) or criminal
// (RIB) — materialises it onto the application row via the repository, and, on
// a real change, records an AUDIT_ENTRY of the state transition.
//
// Idempotent by construction: the repository returns NO_CHANGE for a
// redelivered verdict and NOT_FOUND for an application absent from the agency's
// schema; both are no-ops here (no audit, no throw), so at-least-once delivery
// is safe. Only genuine infrastructure faults propagate — the consumer then
// leaves the Kafka offset uncommitted and the verdict is redelivered.
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { Agency, AuditEvent } from '@usrp/shared-types';
import type {
  ApplicationRepository,
  ApplyVettingOutcome,
  VettingResult,
} from '../ports/application-repository.js';

export interface ProjectVettingResultCommand {
  readonly result: VettingResult;
  /** Correlation context derived from the triggering vetting event. */
  readonly context: EventContext;
  /** Owning agency — attributed on the audit entry. */
  readonly agency: Agency;
}

export interface ProjectVettingResultDeps {
  readonly repository: ApplicationRepository;
  readonly eventBus: EventBus;
}

export class ProjectVettingResultService {
  constructor(private readonly deps: ProjectVettingResultDeps) {}

  async project(command: ProjectVettingResultCommand): Promise<ApplyVettingOutcome> {
    const outcome = await this.deps.repository.applyVettingResult(command.result);

    // A no-op (idempotent redelivery) or a mis-routed/unknown application makes
    // no audit noise — the trail records state CHANGES only.
    if (outcome.kind !== 'APPLIED') return outcome;

    const rejected = outcome.toStatus === 'REJECTED';
    const action = rejected
      ? 'APPLICATION_REJECTED'
      : outcome.statusChanged
        ? 'APPLICATION_STATUS_ADVANCED'
        : 'APPLICATION_VERDICT_RECORDED';

    const event: AuditEvent = {
      ...newEnvelope(command.context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICATION',
      entityId: command.result.applicationId,
      action,
      performedBy: 'application-service',
      agency: command.agency,
      previousStatus: outcome.fromStatus,
      newStatus: outcome.toStatus,
      metadata: {
        dimension: outcome.dimension,
        statusChanged: outcome.statusChanged,
        ...(command.result.dimension === 'ACADEMIC'
          ? { academicStatus: command.result.academicStatus, verifiedVia: command.result.verifiedVia }
          : {
              criminalStatus: command.result.criminalStatus,
              appliedThreshold: command.result.appliedThreshold,
            }),
      },
    };
    await this.deps.eventBus.publish(event);

    return outcome;
  }
}
