// ══════════════════════════════════════════════════════════════════
// application-service — Voluntary self-withdrawal use case (ADR-020)
//
// The citizen's own act on their own application. The caller is the
// portal backend (identity-service) holding a kind:'system' token — it
// has already authenticated the citizen's session and asks on their
// behalf, so the applicantId here is session-derived truth, never a
// body-supplied claim about someone else.
//
// A genuine transition is audited once, against the application's OWN
// agency, performedBy the applicant's opaque UUID (the data subject
// acted — not SYSTEM, not an officer). Idempotent re-requests and
// refused terminal states write nothing and audit nothing: the audit
// stream records state changes, not door knocks.
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { Principal } from '@usrp/shared-auth';
import type { AuditEvent } from '@usrp/shared-types';
import type {
  SelfWithdrawalRepository,
  WithdrawOwnOutcome,
} from '../ports/self-withdrawal-repository.js';

export interface WithdrawOwnCommand {
  readonly actor: Principal;
  readonly applicantId: string;
  readonly applicationId: string;
  readonly context: EventContext;
}

export type SelfWithdrawalOutcome = WithdrawOwnOutcome | { readonly kind: 'FORBIDDEN' };

export interface SelfWithdrawalDeps {
  readonly repository: SelfWithdrawalRepository;
  readonly eventBus: EventBus;
}

export class SelfWithdrawalService {
  constructor(private readonly deps: SelfWithdrawalDeps) {}

  async withdrawOwn(command: WithdrawOwnCommand): Promise<SelfWithdrawalOutcome> {
    if (command.actor.kind !== 'system') {
      return { kind: 'FORBIDDEN' };
    }

    const outcome = await this.deps.repository.withdrawOwn({
      applicantId: command.applicantId,
      applicationId: command.applicationId,
      correlationId: command.context.correlationId,
    });

    if (outcome.kind === 'WITHDRAWN') {
      const event: AuditEvent = {
        ...newEnvelope(command.context),
        eventType: 'AUDIT_ENTRY',
        entityType: 'APPLICATION',
        entityId: command.applicationId,
        action: 'APPLICATION_WITHDRAWN',
        performedBy: command.applicantId,
        agency: outcome.agency,
        previousStatus: outcome.fromStatus,
        newStatus: 'WITHDRAWN',
        metadata: {
          stage: 'SELF_SERVICE',
          cause: 'APPLICANT_REQUEST',
        },
      };
      await this.deps.eventBus.publish(event);
    }

    return outcome;
  }
}
