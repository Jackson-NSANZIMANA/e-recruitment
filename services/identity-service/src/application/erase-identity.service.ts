// ══════════════════════════════════════════════════════════════════
// identity-service — Right-to-erasure use case (ADR-015)
//
// Executes a citizen's erasure request against the identity aggregate.
// Unlike the officer-transition audits (state CHANGES only), erasure
// audits EVERY attempt — executed AND refused: under Law N° 058/2021
// the refusal of an erasure request, and its legal ground, is itself an
// accountable act the controller must be able to evidence. The trail is
// PII-free: applicant UUID, outcome code, refusal ground — never a
// name, NID, or hash.
// ══════════════════════════════════════════════════════════════════

import type { Principal } from '@usrp/shared-auth';
import { newCorrelationContext, newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { AuditEvent } from '@usrp/shared-types';
import type { EraseIdentityOutcome, ErasureRepository } from '../ports/erasure-repository.js';

export interface EraseIdentityCommand {
  readonly applicantId: string;
  readonly context?: EventContext;
}

export interface EraseIdentityDeps {
  readonly repository: ErasureRepository;
  readonly eventBus: EventBus;
}

export class EraseIdentityService {
  constructor(private readonly deps: EraseIdentityDeps) {}

  /**
   * @param officer the VERIFIED officer principal executing the request —
   *   erasure is an accountable human act; system tokens are rejected at
   *   the edge. Any agency may execute: the gate inside the repository,
   *   not the caller's affiliation, decides lawfulness.
   */
  async erase(
    command: EraseIdentityCommand,
    officer: Extract<Principal, { kind: 'officer' }>,
  ): Promise<EraseIdentityOutcome> {
    const outcome = await this.deps.repository.eraseIdentity(command.applicantId);
    const context = command.context ?? newCorrelationContext();

    // NOT_FOUND emits nothing — there is no data subject to account for.
    if (outcome.kind === 'NOT_FOUND') return outcome;

    const executed = outcome.kind === 'ERASED' || outcome.kind === 'ALREADY_ERASED';
    const event: AuditEvent = {
      ...newEnvelope(context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICANT',
      entityId: command.applicantId,
      action: executed ? 'ERASURE_EXECUTED' : 'ERASURE_REFUSED',
      performedBy: officer.subjectId,
      agency: officer.agency,
      metadata: this.metadataFor(outcome),
    };
    await this.deps.eventBus.publish(event);
    return outcome;
  }

  /** Outcome → PII-free audit metadata (codes and agency labels only). */
  private metadataFor(outcome: Exclude<EraseIdentityOutcome, { kind: 'NOT_FOUND' }>): Record<string, unknown> {
    switch (outcome.kind) {
      case 'ERASED':
        return { outcome: 'ERASED' };
      case 'ALREADY_ERASED':
        return { outcome: 'ALREADY_ERASED' };
      case 'REFUSED_ACTIVE_APPLICATION':
        return {
          outcome: 'REFUSED',
          ground: 'ACTIVE_APPLICATION',
          agency: outcome.agency,
          status: outcome.status,
        };
      case 'REFUSED_ACCEPT_LOCKED':
        return {
          outcome: 'REFUSED',
          ground: 'ACCEPT_LOCKED',
          lockedByAgency: outcome.lockedByAgency,
        };
    }
  }
}
