// ══════════════════════════════════════════════════════════════════
// application-service — ProjectForensicsResult use case
//
// The amber lane's routing half (ADR-011). document-forensics-service has
// already durably recorded the verdict on document_records and emitted
// DOCUMENT_FORENSICS_COMPLETED; this projection routes the LANE onto the
// application status: RED → REJECTED (pre-slot) / ADJUDICATION_REVIEW
// (post-slot), AMBER → DOCUMENT_REVIEW_AMBER hold, GREEN → no status change.
// application-service remains the single writer of application state
// (ADR-006). Only a genuine transition (APPLIED) writes an AUDIT_ENTRY —
// NO_CHANGE / NOT_APPLICABLE / NOT_FOUND are silent no-ops, mirroring the
// other projection use cases.
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { Agency, AuditEvent } from '@usrp/shared-types';
import type {
  ApplicationRepository,
  ApplyForensicsOutcome,
  ForensicsRoutingResult,
} from '../ports/application-repository.js';

export interface ProjectForensicsResultCommand {
  readonly result: ForensicsRoutingResult;
  readonly agency: Agency;
  readonly context: EventContext;
}

export interface ProjectForensicsResultDeps {
  readonly repository: ApplicationRepository;
  readonly eventBus: EventBus;
}

export class ProjectForensicsResultService {
  readonly #deps: ProjectForensicsResultDeps;

  constructor(deps: ProjectForensicsResultDeps) {
    this.#deps = deps;
  }

  async project(command: ProjectForensicsResultCommand): Promise<ApplyForensicsOutcome> {
    const outcome = await this.#deps.repository.applyForensicsRouting(command.result);
    if (outcome.kind !== 'APPLIED') return outcome;

    const audit: AuditEvent = {
      ...newEnvelope(command.context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICATION',
      entityId: command.result.applicationId,
      action:
        outcome.toStatus === 'REJECTED' ? 'APPLICATION_REJECTED' : 'APPLICATION_STATUS_ADVANCED',
      performedBy: 'application-service',
      agency: command.agency,
      previousStatus: outcome.fromStatus,
      newStatus: outcome.toStatus,
      metadata: {
        stage: 'DOCUMENT_FORENSICS_ROUTING',
        lane: command.result.lane,
        documentId: command.result.documentId,
      },
    };
    await this.#deps.eventBus.publish(audit);

    return outcome;
  }
}
