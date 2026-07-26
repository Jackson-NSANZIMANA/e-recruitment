// ══════════════════════════════════════════════════════════════════
// application-service — Project application-accepted → auto-withdrawal
//
// The consequence of enlistment (ADR-017): one APPLICATION_ACCEPTED event —
// emitted by the officer accept after the cross-agency accept-lock (ADR-014)
// stamped this citizen as accepted platform-wide — retires every OTHER
// in-flight application the citizen has (owner D6: all agencies, all
// campaigns, both lanes, adjudication holds included). WITHDRAWN's first
// writer: the lifecycle's last unreachable status becomes reachable here.
//
// application-service remains the single writer of application state
// (ADR-006); this projection is its fifth ingress. Idempotent by
// construction: a redelivered acceptance finds no non-terminal siblings →
// empty result → no writes, no audit. Each genuine withdrawal is audited
// individually, attributed to the service (no human made this decision),
// against the withdrawn row's OWN agency.
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { Agency, AuditEvent } from '@usrp/shared-types';
import type { WithdrawalRepository, WithdrawnApplication } from '../ports/withdrawal-repository.js';

export interface ProjectApplicationAcceptedCommand {
  readonly applicantId: string;
  readonly acceptedApplicationId: string;
  /** The accepting agency — recorded on each withdrawal's audit metadata. */
  readonly acceptedByAgency: Agency;
  /** Correlation context derived from the triggering APPLICATION_ACCEPTED event. */
  readonly context: EventContext;
}

export interface ProjectApplicationAcceptedDeps {
  readonly repository: WithdrawalRepository;
  readonly eventBus: EventBus;
}

export class ProjectApplicationAcceptedService {
  constructor(private readonly deps: ProjectApplicationAcceptedDeps) {}

  async project(command: ProjectApplicationAcceptedCommand): Promise<readonly WithdrawnApplication[]> {
    const withdrawn = await this.deps.repository.withdrawSiblings({
      applicantId: command.applicantId,
      acceptedApplicationId: command.acceptedApplicationId,
      correlationId: command.context.correlationId,
    });

    // One audit entry PER retired application — each names its own agency and
    // prior stage; all carry the cause. Nothing withdrawn → nothing audited.
    for (const app of withdrawn) {
      const event: AuditEvent = {
        ...newEnvelope(command.context),
        eventType: 'AUDIT_ENTRY',
        entityType: 'APPLICATION',
        entityId: app.applicationId,
        action: 'APPLICATION_WITHDRAWN',
        performedBy: 'application-service',
        agency: app.agency,
        previousStatus: app.fromStatus,
        newStatus: 'WITHDRAWN',
        metadata: {
          stage: 'AUTO_WITHDRAWAL',
          cause: 'ACCEPTED_ELSEWHERE',
          acceptedApplicationId: command.acceptedApplicationId,
          acceptedByAgency: command.acceptedByAgency,
        },
      };
      await this.deps.eventBus.publish(event);
    }

    return withdrawn;
  }
}
