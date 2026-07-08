// ══════════════════════════════════════════════════════════════════
// eligibility-service — Evaluate age eligibility (use case)
//
// Read the applicant's verified identity, compute the age gate for the
// chosen category, and record an immutable audit of the decision.
// Business outcomes (applicant unknown, identity not yet verified) are
// RETURN VALUES; only infrastructure faults throw. The applicant's raw
// date of birth never appears in the audit event, a log, or the return
// value beyond the derived age — see the edge stripping in the HTTP adapter.
// ══════════════════════════════════════════════════════════════════

import { newCorrelationContext, newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type {
  AgeEligibilityCompletedEvent,
  AgeEligibilityResult,
  AgeEligibilityStatus,
  Agency,
  ApplicationCategory,
  AuditEvent,
} from '@usrp/shared-types';
import type { IdentityReader } from '../ports/identity-reader.js';
import { evaluateAgeEligibility } from '../domain/age-rules.js';
import { agencyForCategory } from '../domain/category-agency.js';

export interface EvaluateAgeEligibilityCommand {
  readonly applicantId: string;
  readonly category: ApplicationCategory;
  /**
   * The application this age check belongs to. Present on the event-driven path
   * (APPLICANT_SUBMITTED carries it) → the gate emits an applicationId-bearing
   * AGE_ELIGIBILITY_COMPLETED so the projection can advance the row. Absent on
   * the ad-hoc HTTP age-check → audit-only, no result event (backward compatible).
   */
  readonly applicationId?: string;
  /** Inbound correlation context; a fresh chain starts when omitted. */
  readonly context?: EventContext;
}

export type EvaluateAgeEligibilityOutcome =
  | {
      readonly kind: 'EVALUATED';
      readonly applicantId: string;
      readonly category: ApplicationCategory;
      readonly agency: Agency;
      readonly result: AgeEligibilityResult;
      readonly event: AuditEvent;
    }
  | { readonly kind: 'APPLICANT_NOT_FOUND'; readonly applicantId: string }
  | {
      readonly kind: 'IDENTITY_NOT_VERIFIED';
      readonly applicantId: string;
      readonly identityStatus: string;
    };

export interface EvaluateAgeEligibilityDeps {
  readonly identityReader: IdentityReader;
  readonly eventBus: EventBus;
  /** Injectable clock for deterministic tests; defaults to real time. */
  readonly clock?: () => Date;
}

export class EvaluateAgeEligibilityService {
  constructor(private readonly deps: EvaluateAgeEligibilityDeps) {}

  async evaluate(command: EvaluateAgeEligibilityCommand): Promise<EvaluateAgeEligibilityOutcome> {
    const applicant = await this.deps.identityReader.findApplicantById(command.applicantId);
    if (applicant === null) {
      return { kind: 'APPLICANT_NOT_FOUND', applicantId: command.applicantId };
    }
    // You cannot assess the eligibility of an identity that isn't verified yet.
    if (applicant.identityStatus !== 'VERIFIED') {
      return {
        kind: 'IDENTITY_NOT_VERIFIED',
        applicantId: command.applicantId,
        identityStatus: applicant.identityStatus,
      };
    }

    const asOf = (this.deps.clock ?? (() => new Date()))();
    const result = evaluateAgeEligibility(command.category, applicant.dateOfBirth, asOf);
    const agency = agencyForCategory(command.category);
    const context = command.context ?? newCorrelationContext();

    // Immutable audit of the decision. Deliberately excludes the raw DOB —
    // only the derived age and verdict are recorded.
    const event: AuditEvent = {
      ...newEnvelope(context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICANT',
      entityId: command.applicantId,
      action: result.eligible ? 'AGE_ELIGIBILITY_PASSED' : 'AGE_ELIGIBILITY_FAILED',
      performedBy: 'eligibility-service',
      agency,
      metadata: {
        category: command.category,
        ageAtEvaluation: result.ageAtEvaluation,
        appliedMaxAge: result.appliedMaxAge,
        eligible: result.eligible,
        reason: result.reason,
      },
    };
    await this.deps.eventBus.publish(event);

    // On the event-driven path we also carry an applicationId, so we emit an
    // applicationId-bearing result the application-service projection can land
    // on the row (the third vetting dimension). The raw DOB never rides along —
    // only the derived age and the applied band, same as the audit entry above.
    // Both events are built from the same context, so they share the inbound
    // correlationId and causationId (the triggering submitted event) — the
    // causal chain stays intact whichever event a consumer observes.
    if (command.applicationId !== undefined) {
      const ageStatus: AgeEligibilityStatus = result.eligible ? 'ELIGIBLE' : 'INELIGIBLE';
      const resultEvent: AgeEligibilityCompletedEvent = {
        ...newEnvelope(context),
        eventType: 'AGE_ELIGIBILITY_COMPLETED',
        applicantId: command.applicantId,
        applicationId: command.applicationId,
        agency,
        category: command.category,
        ageStatus,
        ageAtEvaluation: result.ageAtEvaluation,
        appliedMaxAge: result.appliedMaxAge,
        eligible: result.eligible,
        reason: result.reason,
      };
      await this.deps.eventBus.publish(resultEvent);
    }

    return { kind: 'EVALUATED', applicantId: command.applicantId, category: command.category, agency, result, event };
  }
}
