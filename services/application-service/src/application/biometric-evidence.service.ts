// ══════════════════════════════════════════════════════════════════
// application-service — Biometric evidence read + supervised manual identity (ADR-037)
//
//   list     the officer application detail's evidence (ADVISORY only —
//            SHADOW is invisible to every officer by engine RLS)
//   confirm  a field supervisor confirms identity after NO_MATCH /
//            INCONCLUSIVE evidence, with a closed reason code, through their
//            OWN authenticated session. Stages MANUAL_IDENTITY_CONFIRMED in the
//            same transaction. The gate admission then records
//            NATIONAL_ID_CARD+SUPERVISOR (and refuses to count a confirmation
//            made by the admitting officer).
// ══════════════════════════════════════════════════════════════════

import { newCorrelationContext, newEnvelope, type EventContext } from '@usrp/shared-events';
import { dbRoleForPrincipal, type Principal } from '@usrp/shared-auth';
import type { AuditEvent } from '@usrp/shared-types';
import type { ManualIdentityReason } from '../domain/gate-identity.js';
import type {
  BiometricEvidenceRepository,
  ConfirmManualIdentityOutcome,
  EvidenceListOutcome,
} from '../ports/biometric-evidence-repository.js';
import type { EventDispatcher } from '../ports/event-outbox.js';
import type { OfficerActor } from '../ports/officer-transition-repository.js';

export interface BiometricEvidenceDeps {
  readonly repository: BiometricEvidenceRepository;
  readonly events: EventDispatcher;
}

export class BiometricEvidenceService {
  readonly #deps: BiometricEvidenceDeps;

  constructor(deps: BiometricEvidenceDeps) {
    this.#deps = deps;
  }

  async list(principal: Principal, applicationId: string): Promise<EvidenceListOutcome> {
    if (principal.kind !== 'officer') return { kind: 'NOT_FOUND' };
    return this.#deps.repository.list(actorOf(principal, newCorrelationContext()), applicationId);
  }

  async confirm(
    principal: Principal,
    recordId: string,
    reasonCode: ManualIdentityReason,
    context?: EventContext,
  ): Promise<ConfirmManualIdentityOutcome> {
    if (principal.kind !== 'officer') return { kind: 'NOT_FOUND' };
    const ctx = context ?? newCorrelationContext();
    const actor = actorOf(principal, ctx);
    const envelope = newEnvelope(ctx);
    const eventsFor = (outcome: ConfirmManualIdentityOutcome): readonly AuditEvent[] =>
      outcome.kind !== 'CONFIRMED'
        ? []
        : [{
            ...envelope,
            eventType: 'AUDIT_ENTRY',
            entityType: 'APPLICATION',
            entityId: outcome.applicationId,
            action: 'MANUAL_IDENTITY_CONFIRMED',
            performedBy: actor.officerId,
            agency: actor.agency,
            metadata: { recordId: outcome.recordId, confirmationId: outcome.confirmationId, reasonCode },
          }];
    const outcome = await this.#deps.repository.confirm(actor, recordId, reasonCode, eventsFor);
    const durable = eventsFor(outcome);
    if (durable.length > 0) await this.#deps.events.dispatch(durable);
    return outcome;
  }
}

function actorOf(principal: Principal & { kind: 'officer' }, context: EventContext): OfficerActor {
  return {
    agency: principal.agency,
    dbRole: dbRoleForPrincipal(principal),
    officerId: principal.subjectId,
    correlationId: context.correlationId,
  };
}
