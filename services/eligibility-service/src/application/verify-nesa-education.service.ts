// ══════════════════════════════════════════════════════════════════
// eligibility-service — Verify NESA (A-Level) education (use case)
//
// Read the applicant's verified identity, look up their NESA results
// (SDMS format, ADR-047), BIND them to the applicant before anything else
// (ADR-048 §2.2: closes the gap where a valid index belonging to someone
// else passed), then evaluate the academic gate for the chosen category,
// and emit BOTH a domain routing event (NESA_VERIFICATION_COMPLETED, so
// downstream vetting can proceed) AND an immutable audit entry.
//
// Not bound, unpublished and review outcomes emit academicStatus PENDING
// with a failureCode (nesa-binding.ts NESA_GATE_CODES): the application is
// never rejected for them, and the citizen copy names no other person. Business outcomes (applicant unknown, identity
// not verified, wrong verification path, no NESA record) are RETURN
// VALUES; only infrastructure faults (NesaUnavailableError, read faults)
// throw. No PII (DOB, raw index) ever enters an event, a log, or the
// return value beyond derived academic facts.
// ══════════════════════════════════════════════════════════════════

import { newCorrelationContext, newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import {
  EDUCATION_REQUIREMENTS,
  type AcademicEligibilityStatus,
  type Agency,
  type ApplicationCategory,
  type AuditEvent,
  type EligibilityResult,
  type NESAVerificationCompletedEvent,
} from '@usrp/shared-types';
import type { IdentityReader } from '../ports/identity-reader.js';
import type { NesaGateway } from '../ports/nesa.gateway.js';
import { evaluateNesaEducation, type EducationEligibilityResult } from '../domain/education-rules.js';
import {
  decideNesaGate,
  NESA_GATE_CODES,
  NESA_NOT_BOUND_CITIZEN_MESSAGE,
  type NesaReviewReason,
} from '../domain/nesa-binding.js';
import type { BindingFields } from '@usrp/shared-identity-match';
import { agencyForCategory } from '../domain/category-agency.js';

export interface VerifyNesaEducationCommand {
  readonly applicantId: string;
  readonly applicationId: string;
  readonly category: ApplicationCategory;
  readonly nesaIndexNumber: string;
  /** Inbound correlation context; a fresh chain starts when omitted. */
  readonly context?: EventContext;
}

export type VerifyNesaEducationOutcome =
  | {
      readonly kind: 'EVALUATED';
      readonly applicantId: string;
      readonly applicationId: string;
      readonly category: ApplicationCategory;
      readonly agency: Agency;
      readonly academicStatus: AcademicEligibilityStatus;
      readonly education: EducationEligibilityResult;
      readonly nesaRequestId: string;
      readonly event: NESAVerificationCompletedEvent;
      readonly audit: AuditEvent;
    }
  | { readonly kind: 'APPLICANT_NOT_FOUND'; readonly applicantId: string }
  | {
      readonly kind: 'IDENTITY_NOT_VERIFIED';
      readonly applicantId: string;
      readonly identityStatus: string;
    }
  | {
      // The category is a degree (HEC) path — NESA A-Level verification does
      // not apply. Prevents silently marking a degree holder INELIGIBLE
      // against A-Level accepted levels.
      readonly kind: 'NESA_NOT_APPLICABLE';
      readonly applicantId: string;
      readonly category: ApplicationCategory;
    }
  | {
      readonly kind: 'NESA_RECORD_NOT_FOUND';
      readonly applicantId: string;
      readonly nesaRequestId: string;
    }
  | {
      // The record does not belong to this applicant: CORRECTABLE, not a verdict.
      readonly kind: 'NESA_NOT_BOUND';
      readonly applicantId: string;
      readonly nesaRequestId: string;
      readonly fields: BindingFields;
    }
  | {
      // published:false — retried later, never ineligible.
      readonly kind: 'NESA_RESULTS_PENDING';
      readonly applicantId: string;
      readonly nesaRequestId: string;
    }
  | {
      // A human decides (amber queue): partial name, malpractice, unknown level...
      readonly kind: 'NESA_REVIEW_REQUIRED';
      readonly applicantId: string;
      readonly nesaRequestId: string;
      readonly reasons: readonly NesaReviewReason[];
      readonly fields: BindingFields;
    };

export interface VerifyNesaEducationDeps {
  readonly identityReader: IdentityReader;
  readonly nesaGateway: NesaGateway;
  readonly eventBus: EventBus;
  /** Injectable clock for deterministic tests; defaults to real time. */
  readonly clock?: () => Date;
}

export class VerifyNesaEducationService {
  constructor(private readonly deps: VerifyNesaEducationDeps) {}

  async verify(command: VerifyNesaEducationCommand): Promise<VerifyNesaEducationOutcome> {
    const applicant = await this.deps.identityReader.findBindingSubjectById(command.applicantId);
    if (applicant === null) {
      return { kind: 'APPLICANT_NOT_FOUND', applicantId: command.applicantId };
    }
    if (applicant.identityStatus !== 'VERIFIED') {
      return {
        kind: 'IDENTITY_NOT_VERIFIED',
        applicantId: command.applicantId,
        identityStatus: applicant.identityStatus,
      };
    }

    // Fail fast if this category is not on the NESA path — degree categories
    // are the HEC slice's responsibility.
    if (!EDUCATION_REQUIREMENTS[command.category].nesaVerificationRequired) {
      return { kind: 'NESA_NOT_APPLICABLE', applicantId: command.applicantId, category: command.category };
    }

    const lookup = await this.deps.nesaGateway.lookupResults(command.nesaIndexNumber);
    const asOf = (this.deps.clock ?? ((): Date => new Date()))();
    const agency = agencyForCategory(command.category);
    const context = command.context ?? newCorrelationContext();

    // No NESA record for that index — fail closed (INELIGIBLE), still emit the
    // completed + audit events so the decision is durable and traceable.
    if (lookup.status === 'NOT_FOUND') {
      const education: EducationEligibilityResult = {
        academicStatus: 'INELIGIBLE',
        meetsRequirement: false,
        reason: `No NESA A-Level record was found for the supplied examination index.`,
        requiredMinLevel: EDUCATION_REQUIREMENTS[command.category].minLevel,
        evaluatedLevel: EDUCATION_REQUIREMENTS[command.category].minLevel,
        evaluationDate: asOf.toISOString(),
      };
      const { event, audit } = this.emit(command, agency, education, lookup.nesaRequestId, context, asOf);
      await this.deps.eventBus.publish(event);
      await this.deps.eventBus.publish(audit);
      return {
        kind: 'NESA_RECORD_NOT_FOUND',
        applicantId: command.applicantId,
        nesaRequestId: lookup.nesaRequestId,
      };
    }

    // ── Bind BEFORE evaluating (ADR-048 §2.2) ──
    const decision = decideNesaGate(
      { fullName: applicant.fullName, dateOfBirth: applicant.dateOfBirth, sex: applicant.sex, nationalIdHint: applicant.nationalIdHint },
      lookup.results,
    );
    const requirement = EDUCATION_REQUIREMENTS[command.category];
    if (decision.kind !== 'EVALUATE') {
      const pending: EducationEligibilityResult = {
        academicStatus: 'PENDING',
        meetsRequirement: false,
        reason:
          decision.kind === 'NOT_BOUND'
            ? NESA_NOT_BOUND_CITIZEN_MESSAGE
            : decision.kind === 'PENDING_UNPUBLISHED'
              ? 'NESA results for this index are not yet published; the check will be repeated.'
              : 'The NESA record needs a review by an officer before the academic check can complete.',
        requiredMinLevel: requirement.minLevel,
        evaluatedLevel: requirement.minLevel,
        evaluationDate: asOf.toISOString(),
      };
      const failureCode =
        decision.kind === 'NOT_BOUND' ? NESA_GATE_CODES.NOT_BOUND : decision.kind === 'PENDING_UNPUBLISHED' ? NESA_GATE_CODES.UNPUBLISHED : NESA_GATE_CODES.REVIEW;
      const reviewReasons = decision.kind === 'REVIEW' ? decision.reasons : [];
      const { event, audit } = this.emit(command, agency, pending, lookup.nesaRequestId, context, asOf, {
        failureCode,
        binding: decision.binding.fields,
        reviewReasons,
      });
      await this.deps.eventBus.publish(event);
      await this.deps.eventBus.publish(audit);
      if (decision.kind === 'NOT_BOUND') {
        return { kind: 'NESA_NOT_BOUND', applicantId: command.applicantId, nesaRequestId: lookup.nesaRequestId, fields: decision.binding.fields };
      }
      if (decision.kind === 'PENDING_UNPUBLISHED') {
        return { kind: 'NESA_RESULTS_PENDING', applicantId: command.applicantId, nesaRequestId: lookup.nesaRequestId };
      }
      return { kind: 'NESA_REVIEW_REQUIRED', applicantId: command.applicantId, nesaRequestId: lookup.nesaRequestId, reasons: decision.reasons, fields: decision.binding.fields };
    }

    const education = evaluateNesaEducation(command.category, decision.facts, asOf);
    const { event, audit } = this.emit(command, agency, education, lookup.nesaRequestId, context, asOf, {
      failureCode: null,
      binding: decision.binding.fields,
      reviewReasons: [],
    });
    await this.deps.eventBus.publish(event);
    await this.deps.eventBus.publish(audit);

    return {
      kind: 'EVALUATED',
      applicantId: command.applicantId,
      applicationId: command.applicationId,
      category: command.category,
      agency,
      academicStatus: education.academicStatus,
      education,
      nesaRequestId: lookup.nesaRequestId,
      event,
      audit,
    };
  }

  /** Build the routing event + immutable audit for a completed evaluation. */
  private emit(
    command: VerifyNesaEducationCommand,
    agency: Agency,
    education: EducationEligibilityResult,
    nesaRequestId: string,
    context: EventContext,
    asOf: Date,
    gate: { readonly failureCode: string | null; readonly binding: BindingFields | null; readonly reviewReasons: readonly NesaReviewReason[] } = { failureCode: null, binding: null, reviewReasons: [] },
  ): { event: NESAVerificationCompletedEvent; audit: AuditEvent } {
    const failureCode = gate.failureCode ?? (education.meetsRequirement ? null : 'EDUCATION_REQUIREMENT_NOT_MET');
    const eligibilityResult: EligibilityResult = {
      eligible: education.meetsRequirement,
      reason: education.reason,
      ...(failureCode === null ? {} : { failureCode }),
      evaluatedAt: asOf.toISOString(),
      details: {
        citizenshipCheck: null,
        ageCheck: null,
        educationCheck: education.academicStatus === 'PENDING' ? null : education.meetsRequirement,
        criminalCheck: null,
        prosecutionCheck: null,
        dismissalCheck: null,
        moralCharacterCheck: null,
        healthCheck: null,
      },
    };

    const event: NESAVerificationCompletedEvent = {
      ...newEnvelope(context),
      eventType: 'NESA_VERIFICATION_COMPLETED',
      applicantId: command.applicantId,
      applicationId: command.applicationId,
      agency,
      category: command.category,
      nesaRequestId,
      eligibilityResult,
      academicStatus: education.academicStatus,
    };

    // Immutable audit of the decision. Deliberately excludes the raw index
    // number and school — only the derived academic verdict is recorded.
    const audit: AuditEvent = {
      ...newEnvelope(context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICANT',
      entityId: command.applicantId,
      action:
        gate.failureCode === NESA_GATE_CODES.NOT_BOUND
          ? 'NESA_RECORD_NOT_BOUND'
          : gate.failureCode === NESA_GATE_CODES.UNPUBLISHED
            ? 'NESA_RESULTS_UNPUBLISHED'
            : gate.failureCode === NESA_GATE_CODES.REVIEW
              ? 'NESA_REVIEW_REQUIRED'
              : education.meetsRequirement
                ? 'NESA_EDUCATION_PASSED'
                : 'NESA_EDUCATION_FAILED',
      performedBy: 'eligibility-service',
      agency,
      metadata: {
        category: command.category,
        academicStatus: education.academicStatus,
        requiredMinLevel: education.requiredMinLevel,
        evaluatedLevel: education.evaluatedLevel,
        meetsRequirement: education.meetsRequirement,
        nesaRequestId,
        reason: education.reason,
        // Per-field binding results (MATCH / PARTIAL / MISMATCH / NOT_COMPARED /
        // UNREADABLE) and review reasons: never the compared values.
        ...(gate.binding === null ? {} : { binding: { ...gate.binding } }),
        ...(gate.reviewReasons.length === 0 ? {} : { reviewReasons: [...gate.reviewReasons] }),
      },
    };

    return { event, audit };
  }
}
