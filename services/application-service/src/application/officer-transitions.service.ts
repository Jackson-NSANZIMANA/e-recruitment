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
 *   • FORBIDDEN — the caller is not an officer (defence-in-depth).
 *   • INVALID_MEDICAL_INPUT — the medical-review body does not match the
 *     caller's agency MODE (ADR-013): RDF runs an in-house medical BOARD
 *     (fitnessStatus), RNP/RCS verify a government-physician CERTIFICATE
 *     (certVerdict + physicianName). The mode is derived from the VERIFIED
 *     principal's agency — a body carrying the other mode's fields (or a
 *     CERT_VERIFIED without a physician name) is a caller error, not a hold.
 *     (This retires the Slice-4 UNSUPPORTED_AGENCY 501: all three agencies
 *     are modelled now.)
 */
export type OfficerCommandOutcome =
  | OfficerTransitionOutcome
  | { readonly kind: 'FORBIDDEN' }
  | { readonly kind: 'INVALID_MEDICAL_INPUT'; readonly reason: string };

/** Agencies on the government-physician CERTIFICATE mode (ADR-013). */
const CERTIFICATE_AGENCIES: ReadonlySet<Agency> = new Set<Agency>(['RNP', 'RCS']);

/** medical_cert_physician_name is varchar(200) on both cert schemas. */
const MAX_PHYSICIAN_NAME = 200;

export interface MedicalReviewCommand {
  readonly actor: Principal;
  readonly applicationId: string;
  /** BOARD mode (RDF): the medical board's fitness verdict. */
  readonly fitnessStatus?: 'FIT' | 'UNFIT';
  /** CERTIFICATE mode (RNP/RCS): the certificate-verification verdict. */
  readonly certVerdict?: 'CERT_VERIFIED' | 'CERT_REJECTED';
  /** CERTIFICATE mode: the signing government physician (required on CERT_VERIFIED). */
  readonly physicianName?: string;
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
    const actor = toActor(command.actor, command.context);

    if (CERTIFICATE_AGENCIES.has(command.actor.agency)) {
      // CERTIFICATE mode (RNP/RCS, ADR-013). Mode comes from the verified
      // agency; a board-mode body against a cert agency is a caller error.
      if (command.certVerdict === undefined || command.fitnessStatus !== undefined) {
        return {
          kind: 'INVALID_MEDICAL_INPUT',
          reason: `${command.actor.agency} medical review verifies a government-physician certificate: send certVerdict (and physicianName when verified), not fitnessStatus`,
        };
      }
      const physicianName = command.physicianName?.trim() ?? '';
      if (command.certVerdict === 'CERT_VERIFIED') {
        if (physicianName.length === 0 || physicianName.length > MAX_PHYSICIAN_NAME) {
          return {
            kind: 'INVALID_MEDICAL_INPUT',
            reason: `CERT_VERIFIED requires physicianName (1-${MAX_PHYSICIAN_NAME} chars) — the signing government physician is the audit substance`,
          };
        }
      } else if (physicianName.length > 0) {
        return {
          kind: 'INVALID_MEDICAL_INPUT',
          reason: 'physicianName only accompanies CERT_VERIFIED',
        };
      }
      const outcome = await this.#repository.medicalReview({
        actor,
        applicationId: command.applicationId,
        mode: 'CERTIFICATE',
        certVerdict: command.certVerdict,
        physicianName: command.certVerdict === 'CERT_VERIFIED' ? physicianName : null,
      });
      // Audit carries the verdict only — the physician name lives in the DB
      // column, not on the event backbone.
      await this.#audit(outcome, command.actor, command.context, command.applicationId, 'MEDICAL_REVIEW', {
        mode: 'CERTIFICATE',
        certVerdict: command.certVerdict,
      });
      return outcome;
    }

    // BOARD mode (RDF): the in-house medical board's fitness verdict.
    if (command.fitnessStatus === undefined || command.certVerdict !== undefined || command.physicianName !== undefined) {
      return {
        kind: 'INVALID_MEDICAL_INPUT',
        reason: 'RDF medical review records the in-house board fitness verdict: send fitnessStatus, not certVerdict/physicianName',
      };
    }
    const outcome = await this.#repository.medicalReview({
      actor,
      applicationId: command.applicationId,
      mode: 'BOARD',
      fitnessStatus: command.fitnessStatus,
    });
    await this.#audit(outcome, command.actor, command.context, command.applicationId, 'MEDICAL_REVIEW', {
      mode: 'BOARD',
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
