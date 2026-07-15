// ══════════════════════════════════════════════════════════════════
// application-service — Officer lifecycle transitions (use case)
//
// The human half of the lifecycle: an authenticated officer drives an
// application through the tail of the green digital lane —
// medical-review → final-decision → accept (+ REJECTED off the first two).
//
// application-service remains the single writer of application state (ADR-006).
// The repository performs the durable transition AS THE OFFICER'S DB ROLE (the
// cross-agency isolation seam); this use case owns the policy around it:
//   • defence-in-depth — a non-officer principal is refused here even though the
//     HTTP wrapper already blocks the wrong token kind;
//   • the agency, DB role, and officer id are taken from the VERIFIED principal,
//     never the request body;
//   • only a genuine transition (APPLIED) writes an AUDIT_ENTRY — NO_CHANGE
//     (idempotent), NOT_APPLICABLE (hold), and NOT_FOUND (cross-agency) are
//     silent no-ops, mirroring the projection use cases.
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type {
  Agency,
  ApplicationEligibilityClearedEvent,
  AuditEvent,
} from '@usrp/shared-types';
import { dbRoleForPrincipal, type Principal } from '@usrp/shared-auth';
import type {
  AdjudicateOutcome,
  OfficerActor,
  OfficerTransitionOutcome,
  OfficerTransitionRepository,
} from '../ports/officer-transition-repository.js';

/**
 * An officer transition outcome plus two use-case guards:
 *   • FORBIDDEN         — the caller is not an officer (defence-in-depth).
 *   • UNSUPPORTED_AGENCY — the transition is not modelled for the caller's agency.
 *     Medical review currently models RDF's in-house fitness test only: RNP has
 *     no medical columns on `applications` and RCS uses a government-physician
 *     certificate (`medical_cert_*`) — genuinely DIFFERENT per agency. Rather
 *     than a raw DB error, this returns a clean, flagged outcome pending the
 *     tri-agency medical-modelling decision (owner/agency call).
 */
export type OfficerCommandOutcome =
  | OfficerTransitionOutcome
  | { readonly kind: 'FORBIDDEN' }
  | { readonly kind: 'UNSUPPORTED_AGENCY'; readonly agency: Agency };

/** Agencies for which the in-house medical-review transition is modelled today. */
const MEDICAL_REVIEW_AGENCIES: ReadonlySet<Agency> = new Set<Agency>(['RDF']);

export interface MedicalReviewCommand {
  readonly actor: Principal;
  readonly applicationId: string;
  readonly fitnessStatus: 'FIT' | 'UNFIT';
  readonly context: EventContext;
}

export interface FinalDecisionCommand {
  readonly actor: Principal;
  readonly applicationId: string;
  readonly decision: 'SHORTLIST' | 'REJECT';
  readonly notes: string | null;
  readonly context: EventContext;
}

export interface AcceptCommand {
  readonly actor: Principal;
  readonly applicationId: string;
  readonly context: EventContext;
}

export interface AdjudicateCommand {
  readonly actor: Principal;
  readonly applicationId: string;
  readonly decision: 'CLEAR' | 'REJECT';
  readonly notes: string | null;
  readonly context: EventContext;
}

/** Adjudication outcome plus the non-officer defence-in-depth guard. */
export type AdjudicateCommandOutcome = AdjudicateOutcome | { readonly kind: 'FORBIDDEN' };

export interface OfficerTransitionsDeps {
  readonly repository: OfficerTransitionRepository;
  readonly eventBus: EventBus;
}

export class OfficerTransitionsService {
  readonly #repository: OfficerTransitionRepository;
  readonly #eventBus: EventBus;

  constructor(deps: OfficerTransitionsDeps) {
    this.#repository = deps.repository;
    this.#eventBus = deps.eventBus;
  }

  async medicalReview(command: MedicalReviewCommand): Promise<OfficerCommandOutcome> {
    if (command.actor.kind !== 'officer') return { kind: 'FORBIDDEN' };
    if (!MEDICAL_REVIEW_AGENCIES.has(command.actor.agency)) {
      return { kind: 'UNSUPPORTED_AGENCY', agency: command.actor.agency };
    }
    const actor = toActor(command.actor, command.context);
    const outcome = await this.#repository.medicalReview({
      actor,
      applicationId: command.applicationId,
      fitnessStatus: command.fitnessStatus,
    });
    await this.#audit(outcome, command.actor, command.context, command.applicationId, 'MEDICAL_REVIEW', {
      fitnessStatus: command.fitnessStatus,
    });
    return outcome;
  }

  async finalDecision(command: FinalDecisionCommand): Promise<OfficerCommandOutcome> {
    if (command.actor.kind !== 'officer') return { kind: 'FORBIDDEN' };
    const actor = toActor(command.actor, command.context);
    const outcome = await this.#repository.finalDecision({
      actor,
      applicationId: command.applicationId,
      decision: command.decision,
      notes: command.notes,
    });
    await this.#audit(outcome, command.actor, command.context, command.applicationId, 'FINAL_DECISION', {
      decision: command.decision,
    });
    return outcome;
  }

  async accept(command: AcceptCommand): Promise<OfficerCommandOutcome> {
    if (command.actor.kind !== 'officer') return { kind: 'FORBIDDEN' };
    const actor = toActor(command.actor, command.context);
    const outcome = await this.#repository.accept({ actor, applicationId: command.applicationId });
    await this.#audit(outcome, command.actor, command.context, command.applicationId, 'ACCEPT', {});
    return outcome;
  }

  /**
   * Adjudicate an amber/late-disqualification hold (ADR-011). When a CLEAR
   * re-derives the row all the way to DOCUMENT_REVIEW_GREEN, re-emit
   * application.cleared so the amber-cleared applicant rejoins the SAME slot
   * lane the green-cleared one travels (owner decision D4 — one
   * reconvergence path, scheduling-service is none the wiser).
   */
  async adjudicate(command: AdjudicateCommand): Promise<AdjudicateCommandOutcome> {
    if (command.actor.kind !== 'officer') return { kind: 'FORBIDDEN' };
    const actor = toActor(command.actor, command.context);
    const outcome = await this.#repository.adjudicate({
      actor,
      applicationId: command.applicationId,
      decision: command.decision,
      notes: command.notes,
    });
    if (outcome.kind !== 'APPLIED') return outcome;

    await this.#audit(
      { kind: 'APPLIED', fromStatus: outcome.fromStatus, toStatus: outcome.toStatus },
      command.actor,
      command.context,
      command.applicationId,
      'ADJUDICATION',
      { decision: command.decision },
    );

    if (outcome.clearedToGreen) {
      const cleared: ApplicationEligibilityClearedEvent = {
        ...newEnvelope(command.context),
        eventType: 'APPLICATION_ELIGIBILITY_CLEARED',
        applicationId: command.applicationId,
        applicantId: outcome.applicantId,
        agency: command.actor.agency,
        campaignId: outcome.campaignId,
        category: outcome.category,
      };
      await this.#eventBus.publish(cleared);
    }
    return outcome;
  }

  /**
   * Record an AUDIT_ENTRY of a genuine officer transition. Attributed to the
   * officer (performedBy = subjectId, plus agency); non-APPLIED outcomes emit
   * nothing — the trail records state CHANGES only.
   */
  async #audit(
    outcome: OfficerTransitionOutcome,
    officer: Extract<Principal, { kind: 'officer' }>,
    context: EventContext,
    applicationId: string,
    stage: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (outcome.kind !== 'APPLIED') return;

    const event: AuditEvent = {
      ...newEnvelope(context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICATION',
      entityId: applicationId,
      action: outcome.toStatus === 'REJECTED' ? 'APPLICATION_REJECTED' : 'APPLICATION_STATUS_ADVANCED',
      performedBy: officer.subjectId,
      agency: officer.agency,
      previousStatus: outcome.fromStatus,
      newStatus: outcome.toStatus,
      metadata: { stage, ...metadata },
    };
    await this.#eventBus.publish(event);
  }
}

/** Build the repository actor from a VERIFIED officer principal + event context. */
function toActor(officer: Extract<Principal, { kind: 'officer' }>, context: EventContext): OfficerActor {
  return {
    agency: officer.agency,
    dbRole: dbRoleForPrincipal(officer),
    officerId: officer.subjectId,
    correlationId: context.correlationId,
  };
}
