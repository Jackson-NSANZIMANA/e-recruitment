// ══════════════════════════════════════════════════════════════════
// eligibility-service — Verify HEC (degree/diploma) education (use case)
//
// The degree-path sibling of the NESA gate. Read the applicant's verified
// identity + G2G subject hash, ask HEC to verify the degree belongs to
// them, evaluate the academic gate (level + specialist field) for the
// category, and emit BOTH a routing event (HEC_VERIFICATION_COMPLETED) and
// an immutable audit entry. Business outcomes (applicant unknown, identity
// not verified, no G2G subject on file, wrong verification path, degree
// not found, holder mismatch) are RETURN VALUES; only infrastructure
// faults (HecUnavailableError, read faults) throw. No PII and no hash ever
// enters an event, a log, or the return value beyond derived academic
// facts.
// ══════════════════════════════════════════════════════════════════

import { newCorrelationContext, newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import {
  EDUCATION_REQUIREMENTS,
  type AcademicEligibilityStatus,
  type Agency,
  type ApplicationCategory,
  type AuditEvent,
  type EligibilityResult,
  type HECVerificationCompletedEvent,
} from '@usrp/shared-types';
import type { IdentityReader } from '../ports/identity-reader.js';
import type { HecGateway } from '../ports/hec.gateway.js';
import {
  evaluateHecEducation,
  type HecEducationEligibilityResult,
} from '../domain/education-rules-hec.js';
import type { EducationEligibilityResult } from '../domain/education-rules.js';
import { agencyForCategory } from '../domain/category-agency.js';

export interface VerifyHecEducationCommand {
  readonly applicantId: string;
  readonly applicationId: string;
  readonly category: ApplicationCategory;
  readonly hecRegistrationNumber: string;
  /** Inbound correlation context; a fresh chain starts when omitted. */
  readonly context?: EventContext;
}

export type VerifyHecEducationOutcome =
  | {
      readonly kind: 'EVALUATED';
      readonly applicantId: string;
      readonly applicationId: string;
      readonly category: ApplicationCategory;
      readonly agency: Agency;
      readonly academicStatus: AcademicEligibilityStatus;
      readonly education: HecEducationEligibilityResult;
      readonly hecRequestId: string;
      readonly event: HECVerificationCompletedEvent;
      readonly audit: AuditEvent;
    }
  | { readonly kind: 'APPLICANT_NOT_FOUND'; readonly applicantId: string }
  | { readonly kind: 'IDENTITY_NOT_VERIFIED'; readonly applicantId: string; readonly identityStatus: string }
  | {
      // The identity predates the encrypted G2G subject-hash column, so the
      // degree cannot be bound to its holder. Fail closed — re-verify identity.
      readonly kind: 'G2G_SUBJECT_UNAVAILABLE';
      readonly applicantId: string;
    }
  | {
      // NESA (A-Level) category — degree verification does not apply.
      readonly kind: 'HEC_NOT_APPLICABLE';
      readonly applicantId: string;
      readonly category: ApplicationCategory;
    }
  | {
      readonly kind: 'DEGREE_NOT_FOUND';
      readonly applicantId: string;
      readonly hecRequestId: string;
    }
  | {
      // Registration exists but is registered to a different citizen.
      readonly kind: 'DEGREE_HOLDER_MISMATCH';
      readonly applicantId: string;
      readonly hecRequestId: string;
    };

export interface VerifyHecEducationDeps {
  readonly identityReader: IdentityReader;
  readonly hecGateway: HecGateway;
  readonly eventBus: EventBus;
  /** Injectable clock for deterministic tests; defaults to real time. */
  readonly clock?: () => Date;
}

export class VerifyHecEducationService {
  constructor(private readonly deps: VerifyHecEducationDeps) {}

  async verify(command: VerifyHecEducationCommand): Promise<VerifyHecEducationOutcome> {
    const subject = await this.deps.identityReader.findG2GSubjectById(command.applicantId);
    if (subject === null) {
      return { kind: 'APPLICANT_NOT_FOUND', applicantId: command.applicantId };
    }
    if (subject.identityStatus !== 'VERIFIED') {
      return { kind: 'IDENTITY_NOT_VERIFIED', applicantId: command.applicantId, identityStatus: subject.identityStatus };
    }
    if (subject.nidaLookupHash === null) {
      return { kind: 'G2G_SUBJECT_UNAVAILABLE', applicantId: command.applicantId };
    }

    // Fail fast if this category is not on the HEC path — A-Level categories
    // are the NESA gate's responsibility.
    if (!EDUCATION_REQUIREMENTS[command.category].hecVerificationRequired) {
      return { kind: 'HEC_NOT_APPLICABLE', applicantId: command.applicantId, category: command.category };
    }

    const lookup = await this.deps.hecGateway.verifyDegree(command.hecRegistrationNumber, subject.nidaLookupHash);
    const asOf = (this.deps.clock ?? (() => new Date()))();
    const agency = agencyForCategory(command.category);
    const context = command.context ?? newCorrelationContext();
    const minLevel = EDUCATION_REQUIREMENTS[command.category].minLevel;

    // No valid degree for this person — fail closed (INELIGIBLE), still emit
    // the completed + audit events so the decision is durable and traceable.
    if (lookup.status === 'NOT_FOUND' || lookup.status === 'HOLDER_MISMATCH') {
      const reason =
        lookup.status === 'HOLDER_MISMATCH'
          ? `The supplied degree registration is registered to a different citizen.`
          : `No HEC degree record was found for the supplied registration number.`;
      const education: EducationEligibilityResult = {
        academicStatus: 'INELIGIBLE',
        meetsRequirement: false,
        reason,
        requiredMinLevel: minLevel,
        evaluatedLevel: minLevel,
        evaluationDate: asOf.toISOString(),
      };
      const action = lookup.status === 'HOLDER_MISMATCH' ? 'HEC_HOLDER_MISMATCH' : 'HEC_DEGREE_NOT_FOUND';
      const { event, audit } = this.emit(command, agency, false, null, education, lookup.hecRequestId, context, asOf, action);
      await this.deps.eventBus.publish(event);
      await this.deps.eventBus.publish(audit);
      return lookup.status === 'HOLDER_MISMATCH'
        ? { kind: 'DEGREE_HOLDER_MISMATCH', applicantId: command.applicantId, hecRequestId: lookup.hecRequestId }
        : { kind: 'DEGREE_NOT_FOUND', applicantId: command.applicantId, hecRequestId: lookup.hecRequestId };
    }

    const education = evaluateHecEducation(command.category, lookup.payload, asOf);
    const action = education.meetsRequirement ? 'HEC_EDUCATION_PASSED' : 'HEC_EDUCATION_FAILED';
    const { event, audit } = this.emit(command, agency, true, lookup.payload.institutionName, education, lookup.hecRequestId, context, asOf, action, lookup.payload);
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
      hecRequestId: lookup.hecRequestId,
      event,
      audit,
    };
  }

  /** Build the routing event + immutable audit for a completed evaluation. */
  private emit(
    command: VerifyHecEducationCommand,
    agency: Agency,
    degreeVerified: boolean,
    _institutionName: string | null,
    education: EducationEligibilityResult,
    hecRequestId: string,
    context: EventContext,
    asOf: Date,
    action: string,
    payload?: import('@usrp/shared-types').HECVerifiedPayload,
  ): { event: HECVerificationCompletedEvent; audit: AuditEvent } {
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

    const event: HECVerificationCompletedEvent = {
      ...newEnvelope(context),
      eventType: 'HEC_VERIFICATION_COMPLETED',
      applicantId: command.applicantId,
      applicationId: command.applicationId,
      agency,
      category: command.category,
      hecRequestId,
      degreeVerified,
      institutionName: payload?.institutionName ?? null,
      degreeTitle: payload?.degreeTitle ?? null,
      graduationYear: payload?.graduationYear ?? null,
      specialistField: payload?.specialistField ?? null,
      eligibilityResult,
      academicStatus: education.academicStatus,
    };

    // Immutable audit of the decision. Records only the derived verdict and
    // degree provenance — never the registration number or the G2G hash.
    const audit: AuditEvent = {
      ...newEnvelope(context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICANT',
      entityId: command.applicantId,
      action,
      performedBy: 'eligibility-service',
      agency,
      metadata: {
        category: command.category,
        academicStatus: education.academicStatus,
        requiredMinLevel: education.requiredMinLevel,
        evaluatedLevel: education.evaluatedLevel,
        meetsRequirement: education.meetsRequirement,
        degreeVerified,
        institutionName: payload?.institutionName ?? null,
        specialistField: payload?.specialistField ?? null,
        hecRequestId,
        reason: education.reason,
      },
    };

    return { event, audit };
  }
}
