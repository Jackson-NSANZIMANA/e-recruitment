// ══════════════════════════════════════════════════════════════════
// application-service — Gate admission (use case, BUILD-003, ADR-034)
//
// The screening officer at the venue gate scans the candidate's exam QR and
// sights their national ID card. This use case spends the QR: one admission
// per application, ever. It is the digital lane's exam-day ingress — the step
// that moves SLOT_ASSIGNED → PHYSICAL_TEST_SCHEDULED, which an SMS delivery
// was meant to do and never could (no SMS provider; known gap).
//
// Audit, staged in the same transaction as the decision:
//   ADMITTED            APPLICANT_ADMITTED_AT_GATE (+ APPLICATION_STATUS_ADVANCED
//                       when the row moved)
//   ALREADY_ADMITTED    GATE_ADMISSION_REFUSED — a spent QR presented again
//   IDENTITY_MISMATCH   GATE_ADMISSION_REFUSED — card does not match the ticket
//   TICKET_NOT_ISSUED   GATE_ADMISSION_REFUSED — forged or altered QR
// Every other refusal is an operational mistake (wrong gate, wrong day) and is
// kept in the attempts log only; the audit log is the legal record of what
// happened to an application, not of a candidate walking to the wrong door.
// ══════════════════════════════════════════════════════════════════

import { newCorrelationContext, newEnvelope, type EventContext } from '@usrp/shared-events';
import { dbRoleForPrincipal, type Principal } from '@usrp/shared-auth';
import type { AuditEvent } from '@usrp/shared-types';
import { parseGateTicket } from '../domain/gate-admission.js';
import type { GateAdmissionOutcome, GateAdmissionRepository } from '../ports/gate-admission-repository.js';
import type { EventDispatcher } from '../ports/event-outbox.js';
import type { OfficerActor } from '../ports/officer-transition-repository.js';

export interface AdmitAtGateCommand {
  readonly actor: Principal;
  readonly token: string;
  readonly gateVenueName: string;
  readonly nationalIdHash: string;
  readonly context?: EventContext;
}

export interface GateAdmissionDeps {
  readonly repository: GateAdmissionRepository;
  readonly events: EventDispatcher;
  /** Injected for tests; defaults to the wall clock. */
  readonly now?: () => Date;
}

const AUDITED_REFUSALS = new Set(['ALREADY_ADMITTED', 'IDENTITY_MISMATCH', 'TICKET_NOT_ISSUED', 'MANUAL_IDENTITY_REQUIRED']);

export class GateAdmissionService {
  readonly #deps: GateAdmissionDeps;

  constructor(deps: GateAdmissionDeps) {
    this.#deps = deps;
  }

  async admit(command: AdmitAtGateCommand): Promise<GateAdmissionOutcome | { readonly outcome: 'FORBIDDEN' }> {
    if (command.actor.kind !== 'officer') return { outcome: 'FORBIDDEN' };
    const context = command.context ?? newCorrelationContext();
    const actor: OfficerActor = {
      agency: command.actor.agency,
      dbRole: dbRoleForPrincipal(command.actor),
      officerId: command.actor.subjectId,
      correlationId: context.correlationId,
    };
    const claims = parseGateTicket(command.token);
    // Created ONCE: eventsFor runs twice (stage in the transaction, dispatch
    // after commit) and must yield the same event ids both times.
    const envelope = newEnvelope(context);
    const statusEnvelope = newEnvelope(context);

    const eventsFor = (outcome: GateAdmissionOutcome): readonly AuditEvent[] => {
      const applicationId = claims?.applicationId;
      if (applicationId === undefined) return [];
      const base = {
        ...envelope,
        eventType: 'AUDIT_ENTRY' as const,
        entityType: 'APPLICATION' as const,
        entityId: applicationId,
        performedBy: actor.officerId,
        agency: actor.agency,
      };
      if (outcome.outcome === 'ADMITTED') {
        const events: AuditEvent[] = [{
          ...base,
          action: 'APPLICANT_ADMITTED_AT_GATE',
          metadata: {
            ticketId: outcome.ticketId,
            venueName: outcome.venueName,
            examDate: outcome.examDate,
            identityMethod: outcome.identityMethod,
            biometricEvidenceIds: [...outcome.evidenceIds],
            manualIdentityConfirmationIds: [...outcome.confirmationIds],
          },
        }];
        if (outcome.advancedTo !== null) {
          events.push({
            ...statusEnvelope,
            eventType: 'AUDIT_ENTRY',
            entityType: 'APPLICATION',
            entityId: applicationId,
            action: 'APPLICATION_STATUS_ADVANCED',
            performedBy: actor.officerId,
            agency: actor.agency,
            previousStatus: outcome.fromStatus,
            newStatus: outcome.advancedTo,
            metadata: { stage: 'GATE_ADMISSION' },
          });
        }
        return events;
      }
      if (AUDITED_REFUSALS.has(outcome.outcome)) {
        return [{
          ...base,
          action: 'GATE_ADMISSION_REFUSED',
          metadata: { reason: outcome.outcome, gateVenueName: command.gateVenueName },
        }];
      }
      return [];
    };

    const outcome = await this.#deps.repository.admit(
      {
        actor,
        token: command.token,
        claims,
        gateVenueName: command.gateVenueName,
        nationalIdHash: command.nationalIdHash,
        now: (this.#deps.now ?? ((): Date => new Date()))(),
      },
      eventsFor,
    );

    // Post-commit fast path only; the events are already durable in the outbox.
    const durable = eventsFor(outcome);
    if (durable.length > 0) await this.#deps.events.dispatch(durable);
    return outcome;
  }
}
