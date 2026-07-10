// ══════════════════════════════════════════════════════════════════
// application-service — Project notification delivery (use case)
//
// The application aggregate's FOURTH ingress (front door creates; vetting
// projection advances through eligibility; slot projection stamps the exam
// slot; this records the invitation delivery and advances SLOT_ASSIGNED →
// PHYSICAL_TEST_SCHEDULED). Emitted by notification-service after it delivers
// (or attempts) the signed-QR invitation.
//
// application-service remains the single writer of application state (ADR-006):
// notification-service DELIVERS but never writes the applications table; this
// projection APPLIES the outcome. Idempotent and hold-safe: NO_CHANGE on
// redelivery, NOT_APPLICABLE before the slot terminal, NOT_FOUND on mis-route —
// all silent no-ops. Only infra faults propagate → offset uncommitted → redelivery.
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { Agency, AuditEvent } from '@usrp/shared-types';
import type {
  ApplicationRepository,
  ApplyNotificationOutcome,
  NotificationDeliveryResult,
} from '../ports/application-repository.js';

export interface ProjectNotificationDeliveryCommand {
  readonly result: NotificationDeliveryResult;
  readonly context: EventContext;
  readonly agency: Agency;
}

export interface ProjectNotificationDeliveryDeps {
  readonly repository: ApplicationRepository;
  readonly eventBus: EventBus;
}

export class ProjectNotificationDeliveryService {
  constructor(private readonly deps: ProjectNotificationDeliveryDeps) {}

  async project(command: ProjectNotificationDeliveryCommand): Promise<ApplyNotificationOutcome> {
    const outcome = await this.deps.repository.applyNotificationDelivery(command.result);

    // Only a genuine transition writes an audit entry; holds and no-ops are silent.
    if (outcome.kind !== 'APPLIED') return outcome;

    const event: AuditEvent = {
      ...newEnvelope(command.context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICATION',
      entityId: command.result.applicationId,
      action: 'APPLICATION_STATUS_ADVANCED',
      performedBy: 'application-service',
      agency: command.agency,
      previousStatus: outcome.fromStatus,
      newStatus: outcome.toStatus,
      metadata: { stage: 'SLOT_INVITATION_DELIVERED', deliveryStatus: command.result.deliveryStatus },
    };
    await this.deps.eventBus.publish(event);

    return outcome;
  }
}
