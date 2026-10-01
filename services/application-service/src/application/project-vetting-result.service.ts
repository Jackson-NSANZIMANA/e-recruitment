// ══════════════════════════════════════════════════════════════════
// application-service — Project vetting result (use case)
//
// The second adapter over the application aggregate (the first is the HTTP
// front door). It takes ONE vetting verdict — age, academic (NESA/HEC) or
// criminal (RIB) — materialises it onto the application row via the
// repository, and, on a real change, records an AUDIT_ENTRY of the state
// transition and (into GREEN) APPLICATION_ELIGIBILITY_CLEARED.
//
// Idempotent by construction: the repository returns NO_CHANGE for a
// redelivered verdict and NOT_FOUND for an application absent from the agency's
// schema; both are no-ops here, so at-least-once delivery is safe.
//
// WHY THE EVENTS ARE STAGED, NOT PUBLISHED (ADR-025). Idempotency is exactly
// what made the old commit-then-publish ordering lethal: if the CLEARED publish
// failed after the GREEN commit, the verdict was redelivered, the repository
// said NO_CHANGE, and CLEARED was never produced again — the application sat
// at DOCUMENT_REVIEW_GREEN and was never scheduled. The events are now built
// from the outcome and persisted IN the projection's transaction; a NO_CHANGE
// redelivery no longer needs to re-emit anything, because nothing was lost.
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventContext, type EventEnvelope } from '@usrp/shared-events';
import type {
  Agency,
  ApplicationEligibilityClearedEvent,
  AuditEvent,
  USRPEvent,
} from '@usrp/shared-types';
import type {
  ApplicationRepository,
  ApplyVettingOutcome,
  VettingResult,
} from '../ports/application-repository.js';
import type { EventDispatcher } from '../ports/event-outbox.js';

export interface ProjectVettingResultCommand {
  readonly result: VettingResult;
  /** Correlation context derived from the triggering vetting event. */
  readonly context: EventContext;
  /** Owning agency — attributed on the audit entry. */
  readonly agency: Agency;
}

export interface ProjectVettingResultDeps {
  readonly repository: ApplicationRepository;
  /** Post-commit dispatch of the staged events (the outbox fast path). */
  readonly events: EventDispatcher;
}

type AppliedVetting = Extract<ApplyVettingOutcome, { readonly kind: 'APPLIED' }>;

/** Per-dimension detail recorded on the audit entry (the shared fields are added by the caller). */
function dimensionMetadata(result: VettingResult): Record<string, unknown> {
  switch (result.dimension) {
    case 'AGE':
      return { ageStatus: result.ageStatus };
    case 'ACADEMIC':
      return { academicStatus: result.academicStatus, verifiedVia: result.verifiedVia };
    case 'CRIMINAL':
      return { criminalStatus: result.criminalStatus, appliedThreshold: result.appliedThreshold };
  }
}

/**
 * The events one APPLIED projection must announce. Pure: the envelopes are
 * supplied, so calling it inside the transaction (to stage) and after it (to
 * dispatch) yields the same events with the same ids.
 */
function projectionEvents(
  command: ProjectVettingResultCommand,
  outcome: AppliedVetting,
  auditEnvelope: EventEnvelope,
  clearedEnvelope: EventEnvelope,
): readonly USRPEvent[] {
  const rejected = outcome.toStatus === 'REJECTED';
  const action = rejected
    ? 'APPLICATION_REJECTED'
    : outcome.statusChanged
      ? 'APPLICATION_STATUS_ADVANCED'
      : 'APPLICATION_VERDICT_RECORDED';

  const audit: AuditEvent = {
    ...auditEnvelope,
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
      ...dimensionMetadata(command.result),
    },
  };
  const events: USRPEvent[] = [audit];

  // The positive eligibility terminal is the first "stage complete" signal on
  // the backbone: announce a genuine transition INTO green so scheduling acts.
  if (outcome.statusChanged && outcome.toStatus === 'DOCUMENT_REVIEW_GREEN') {
    const cleared: ApplicationEligibilityClearedEvent = {
      ...clearedEnvelope,
      eventType: 'APPLICATION_ELIGIBILITY_CLEARED',
      applicationId: command.result.applicationId,
      applicantId: outcome.applicantId,
      agency: command.agency,
      campaignId: outcome.campaignId,
      category: outcome.category,
    };
    events.push(cleared);
  }
  return events;
}

export class ProjectVettingResultService {
  constructor(private readonly deps: ProjectVettingResultDeps) {}

  async project(command: ProjectVettingResultCommand): Promise<ApplyVettingOutcome> {
    const auditEnvelope = newEnvelope(command.context);
    const clearedEnvelope = newEnvelope(command.context);
    // NO_CHANGE / NOT_FOUND announce nothing: the trail records state CHANGES only.
    const announce = (outcome: ApplyVettingOutcome): readonly USRPEvent[] =>
      outcome.kind === 'APPLIED'
        ? projectionEvents(command, outcome, auditEnvelope, clearedEnvelope)
        : [];

    const outcome = await this.deps.repository.applyVettingResult(command.result, announce);
    await this.deps.events.dispatch(announce(outcome));
    return outcome;
  }
}
