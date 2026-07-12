// ══════════════════════════════════════════════════════════════════
// application-service — Project physical-test completion (use case)
//
// The application aggregate's FIFTH ingress. Emitted by field-sync-service
// (FIELD_SCORE_CAPTURED) once a device-signed physical-test score is cleanly
// accepted or a conflict is resolved. This advances PHYSICAL_TEST_SCHEDULED →
// PHYSICAL_TEST_COMPLETE and stamps the winning score row (ADR-010 §4).
//
// application-service remains the single writer of application state (ADR-006):
// field-sync owns the score log and DELIVERS the event; this projection APPLIES
// the state transition, enforcing the biometric-pass precondition. Idempotent
// and hold-safe: NO_CHANGE on redelivery, NOT_APPLICABLE before the scheduled
// stage, BIOMETRIC_NOT_VERIFIED / SCORE_NOT_FOUND / NOT_FOUND are silent holds.
// Only infra faults propagate → offset uncommitted → redelivery.
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { Agency, AuditEvent } from '@usrp/shared-types';
import type {
  ApplicationRepository,
  ApplyPhysicalTestOutcome,
  PhysicalTestCompleteResult,
} from '../ports/application-repository.js';

export interface ProjectPhysicalTestCompleteCommand {
  readonly result: PhysicalTestCompleteResult;
  readonly context: EventContext;
  readonly agency: Agency;
}

export interface ProjectPhysicalTestCompleteDeps {
  readonly repository: ApplicationRepository;
  readonly eventBus: EventBus;
}

export class ProjectPhysicalTestCompleteService {
  constructor(private readonly deps: ProjectPhysicalTestCompleteDeps) {}

  async project(
    command: ProjectPhysicalTestCompleteCommand,
  ): Promise<ApplyPhysicalTestOutcome> {
    const outcome = await this.deps.repository.applyPhysicalTestComplete(command.result);

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
      metadata: {
        stage: 'PHYSICAL_TEST_COMPLETE',
        physicalTestScoreId: outcome.physicalTestScoreId,
      },
    };
    await this.deps.eventBus.publish(event);

    return outcome;
  }
}
