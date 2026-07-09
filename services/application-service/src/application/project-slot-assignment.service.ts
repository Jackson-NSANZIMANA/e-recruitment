// ══════════════════════════════════════════════════════════════════
// application-service — Project slot assignment (use case)
//
// The third adapter over the application aggregate (front door creates, vetting
// projection advances through eligibility, this stamps the exam slot). It takes
// ONE SLOT_ASSIGNED verdict from scheduling-service, materialises the venue/QR
// onto the application row, and — on a real transition — records an AUDIT_ENTRY.
//
// application-service remains the single writer of application state (ADR-006):
// scheduling-service DECIDES the venue but never writes the applications table;
// this projection APPLIES it, exactly as the vetting projection applies verdicts.
//
// Idempotent and hold-safe by construction: the repository returns NO_CHANGE for
// a redelivered assignment, NOT_ASSIGNABLE when the row is not at the green
// terminal, and NOT_FOUND for a mis-routed application — all no-ops here (no
// audit, no throw). Only infrastructure faults propagate → offset uncommitted →
// redelivery.
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { Agency, AuditEvent } from '@usrp/shared-types';
import type { ApplicationRepository, ApplySlotOutcome, SlotAssignmentResult } from '../ports/application-repository.js';

export interface ProjectSlotAssignmentCommand {
  readonly result: SlotAssignmentResult;
  /** Correlation context derived from the triggering SLOT_ASSIGNED event. */
  readonly context: EventContext;
  /** Owning agency — attributed on the audit entry. */
  readonly agency: Agency;
}

export interface ProjectSlotAssignmentDeps {
  readonly repository: ApplicationRepository;
  readonly eventBus: EventBus;
}

export class ProjectSlotAssignmentService {
  constructor(private readonly deps: ProjectSlotAssignmentDeps) {}

  async project(command: ProjectSlotAssignmentCommand): Promise<ApplySlotOutcome> {
    const outcome = await this.deps.repository.applySlotAssignment(command.result);

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
        stage: 'SLOT_ASSIGNMENT',
        assignedDistrict: command.result.assignedDistrict,
        assignedVenueName: command.result.assignedVenueName,
        examDate: command.result.examDate,
        // The QR code is an opaque invitation token; recorded for traceability.
        qrInvitationCode: command.result.qrInvitationCode,
      },
    };
    await this.deps.eventBus.publish(event);

    return outcome;
  }
}
