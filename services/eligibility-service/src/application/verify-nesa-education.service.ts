// ══════════════════════════════════════════════════════════════════
// eligibility-service — Verify NESA (A-Level) education (use case)
//
// Read the applicant's verified identity, look up their NESA A-Level
// results over the G2G tunnel, evaluate the academic gate for the chosen
// category, and emit BOTH a domain routing event (NESA_VERIFICATION_
// COMPLETED, so downstream vetting can proceed) AND an immutable audit
// entry of the decision. Business outcomes (applicant unknown, identity
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
    const applicant = await this.deps.identityReader.findApplicantById(command.applicantId);
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
    const asOf = (this.deps.clock ?? (() => new Date()))();
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

    const education = evaluateNesaEducation(command.category, lookup.payload, asOf);
    const { event, audit } = this.emit(command, agency, education, lookup.nesaRequestId, context, asOf);
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
  ): { event: NESAVerificationCompletedEvent; audit: AuditEvent } {
    const eligibilityResult: EligibilityResult = {
      eligible: education.meetsRequirement,
      reason: education.reason,
      ...(education.meetsRequirement ? {} : { failureCode: 'EDUCATION_REQUIREMENT_NOT_MET' }),
      evaluatedAt: asOf.toISOString(),
      details: {
        citizenshipCheck: null,
        ageCheck: null,
        educationCheck: education.meetsRequirement,
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
      action: education.meetsRequirement ? 'NESA_EDUCATION_PASSED' : 'NESA_EDUCATION_FAILED',
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
      },
    };

    return { event, audit };
  }
}
