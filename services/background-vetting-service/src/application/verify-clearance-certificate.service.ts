// ══════════════════════════════════════════════════════════════════
// background-vetting-service — Verify a criminal-clearance CERTIFICATE (use case)
//
// The applicant gave the Irembo application number of their certificate
// (CLEARANCE_CERTIFICATE_SUBMITTED). In order (ADR-048 §2.3):
//
//   shape → read the verified identity → registry lookup → the pure ordered
//   checks (authentic, allowed type, validity window, identity binding,
//   content) → append the verification record (rls/0040) → emit.
//
// Emits, with the source recorded:
//   • CLEARED / REVIEW     RIB_VETTING_COMPLETED (source IREMBO_CERTIFICATE,
//                          failure/review reasons) + AUDIT_ENTRY. The state
//                          projection moves the application.
//   • CORRECTION_NEEDED    AUDIT_ENTRY only, and the verification record. NO
//                          vetting event: a correctable failure is not a
//                          verdict, and a PENDING event could regress an
//                          application that is already CLEARED.
//
// OUTAGES: a registry fault never becomes a negative verdict. A best-effort
// PENDING record (REGISTRY_UNAVAILABLE, deduplicated) lets the citizen's
// checklist say "we are verifying", then the error PROPAGATES so the
// consumer leaves the offset uncommitted and the check is retried.
//
// No name, date of birth or certificate value reaches an event, a log, a
// record or the return value: closed codes, per-field binding results, the
// certificate type and its issue date only.
// ══════════════════════════════════════════════════════════════════

import { createHmac } from 'node:crypto';
import { logError } from '@usrp/shared-logging';
import { newCorrelationContext, newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { BindingFields } from '@usrp/shared-identity-match';
import {
  CRIMINAL_THRESHOLD_BY_CATEGORY,
  type Agency,
  type ApplicationCategory,
  type AuditEvent,
  type CriminalClearanceStatus,
  type RIBVettingCompletedEvent,
} from '@usrp/shared-types';
import {
  ClearanceRegistryUnavailableError,
  type ClearanceFailureCode,
  type ClearanceLookup,
  type ClearancePolicy,
} from '../domain/clearance.types.js';
import { parseClearanceNumber } from '../domain/clearance-number.js';
import { decideClearance, type ClearanceDecision } from '../domain/clearance-rules.js';
import type { ApplicantIdentityReader } from '../ports/applicant-identity.reader.js';
import type { ClearanceCertificateGateway } from '../ports/clearance-certificate.gateway.js';
import type { ClearanceVerificationRecord, ClearanceVerificationRepository } from '../ports/clearance-verification.repository.js';

export interface VerifyClearanceCertificateCommand {
  readonly applicantId: string;
  readonly applicationId: string;
  readonly agency: Agency;
  readonly category: ApplicationCategory;
  /** As typed by the applicant; normalised and shape-checked here. */
  readonly clearanceCertificateNumber: string;
  /** Calendar date (YYYY-MM-DD, Africa/Kigali) the validity window is measured against. */
  readonly referenceDate: string;
  readonly context?: EventContext;
}

export type VerifyClearanceCertificateOutcome =
  | { readonly kind: 'CLEARED'; readonly requestId: string | null }
  | { readonly kind: 'REVIEW_REQUIRED'; readonly reasons: readonly string[]; readonly requestId: string | null }
  | { readonly kind: 'CORRECTION_NEEDED'; readonly code: ClearanceFailureCode; readonly fields: BindingFields | null; readonly requestId: string | null }
  | { readonly kind: 'APPLICANT_NOT_FOUND'; readonly applicantId: string }
  | { readonly kind: 'IDENTITY_NOT_VERIFIED'; readonly applicantId: string };

export interface VerifyClearanceCertificateDeps {
  readonly gateway: ClearanceCertificateGateway;
  readonly identityReader: ApplicantIdentityReader;
  readonly repository: ClearanceVerificationRepository;
  readonly eventBus: EventBus;
  readonly policy: ClearancePolicy;
  /** HMAC key for the stored reference (CLEARANCE_REFERENCE_HMAC_KEY). */
  readonly referenceHmacKey: string;
}

const STATUS_BY_KIND: Readonly<Record<'CLEARED' | 'REVIEW', CriminalClearanceStatus>> = { CLEARED: 'CLEARED', REVIEW: 'UNDER_REVIEW' };

export class VerifyClearanceCertificateService {
  constructor(private readonly deps: VerifyClearanceCertificateDeps) {}

  async verify(command: VerifyClearanceCertificateCommand): Promise<VerifyClearanceCertificateOutcome> {
    const context = command.context ?? newCorrelationContext();
    const number = parseClearanceNumber(command.clearanceCertificateNumber);
    // A malformed number is still held only as an HMAC and a last-4 the table accepts:
    // sanitised, so a bad producer cannot make a poison message the partition re-reads forever.
    const referenceKey = number ?? command.clearanceCertificateNumber.trim().toUpperCase().replace(/[^A-Z0-9]/g, '*').slice(0, 64);
    const base = {
      agency: command.agency,
      applicationId: command.applicationId,
      applicantId: command.applicantId,
      referenceHmac: this.hmac(referenceKey),
      referenceLast4: referenceKey.slice(-4).padStart(4, '*'),
      correlationId: context.correlationId,
    };

    const applicant = await this.deps.identityReader.findBindingSubjectById(command.applicantId);
    if (applicant === null) return { kind: 'APPLICANT_NOT_FOUND', applicantId: command.applicantId };
    if (applicant.identityStatus !== 'VERIFIED') return { kind: 'IDENTITY_NOT_VERIFIED', applicantId: command.applicantId };

    // 0. Shape. Not an eligibility verdict: the applicant may correct the number.
    if (number === null) {
      const decision: ClearanceDecision = { kind: 'CORRECTION_NEEDED', code: 'CERTIFICATE_NUMBER_MALFORMED', certificateType: null, issuedOn: null, binding: null };
      return this.conclude(command, context, base, decision, null);
    }

    // 1. The registry. A fault is never a verdict.
    let lookup: ClearanceLookup;
    try {
      lookup = await this.deps.gateway.verify(number);
    } catch (error) {
      if (error instanceof ClearanceRegistryUnavailableError) await this.recordPending(base, error.requestId);
      throw error;
    }

    // 2. The ordered checks.
    const decision = decideClearance(
      lookup,
      { fullName: applicant.fullName, dateOfBirth: applicant.dateOfBirth, sex: applicant.sex, nationalIdHint: applicant.nationalIdHint },
      this.deps.policy,
      command.referenceDate,
    );
    return this.conclude(command, context, base, decision, lookup.requestId);
  }

  private hmac(value: string): string {
    return createHmac('sha256', this.deps.referenceHmacKey).update(value).digest('hex');
  }

  /** Best effort: the retry matters more than the note, so a failed write is logged, not thrown. */
  private async recordPending(base: Pick<ClearanceVerificationRecord, 'agency' | 'applicationId' | 'applicantId' | 'referenceHmac' | 'referenceLast4' | 'correlationId'>, requestId: string): Promise<void> {
    try {
      await this.deps.repository.record({
        ...base, certificateType: null, issuedOn: null, outcome: 'PENDING', failureCode: 'REGISTRY_UNAVAILABLE',
        reviewReasons: [], binding: null, requestId,
      });
    } catch {
      logError('clearance_pending_not_recorded', { applicationId: base.applicationId });
    }
  }

  private async conclude(
    command: VerifyClearanceCertificateCommand,
    context: EventContext,
    base: Pick<ClearanceVerificationRecord, 'agency' | 'applicationId' | 'applicantId' | 'referenceHmac' | 'referenceLast4' | 'correlationId'>,
    decision: ClearanceDecision,
    requestId: string | null,
  ): Promise<VerifyClearanceCertificateOutcome> {
    const reviewReasons = decision.kind === 'REVIEW' ? decision.reasons : [];
    await this.deps.repository.record({
      ...base,
      certificateType: decision.certificateType,
      issuedOn: decision.issuedOn,
      outcome: decision.kind,
      failureCode: decision.kind === 'CORRECTION_NEEDED' ? decision.code : null,
      reviewReasons,
      binding: decision.binding,
      requestId,
    });

    const agency = command.agency;
    const appliedThreshold = CRIMINAL_THRESHOLD_BY_CATEGORY[command.category];

    if (decision.kind !== 'CORRECTION_NEEDED') {
      const vettingEvent: RIBVettingCompletedEvent = {
        ...newEnvelope(context),
        eventType: 'RIB_VETTING_COMPLETED',
        applicantId: command.applicantId,
        applicationId: command.applicationId,
        agency,
        category: command.category,
        ribRequestId: requestId ?? 'none',
        clearanceStatus: STATUS_BY_KIND[decision.kind],
        appliedThreshold,
        source: 'IREMBO_CERTIFICATE',
        ...(reviewReasons.length === 0 ? {} : { reviewReasons }),
      };
      await this.deps.eventBus.publish(vettingEvent);
    }

    const audit: AuditEvent = {
      ...newEnvelope(context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICATION',
      entityId: command.applicationId,
      action:
        decision.kind === 'CLEARED'
          ? 'CLEARANCE_CERTIFICATE_PASSED'
          : decision.kind === 'REVIEW'
            ? 'CLEARANCE_CERTIFICATE_REVIEW_REQUIRED'
            : 'CLEARANCE_CERTIFICATE_CORRECTION_NEEDED',
      performedBy: 'background-vetting-service',
      agency,
      metadata: {
        applicantId: command.applicantId,
        category: command.category,
        source: 'IREMBO_CERTIFICATE',
        appliedThreshold,
        referenceLast4: base.referenceLast4,
        ...(decision.certificateType === null ? {} : { certificateType: decision.certificateType }),
        ...(decision.issuedOn === null ? {} : { issuedOn: decision.issuedOn }),
        ...(decision.kind === 'CORRECTION_NEEDED' ? { failureCode: decision.code } : {}),
        ...(reviewReasons.length === 0 ? {} : { reviewReasons: [...reviewReasons] }),
        // Per-field binding results (MATCH / PARTIAL / MISMATCH / NOT_COMPARED / UNREADABLE): never the compared values.
        ...(decision.binding === null ? {} : { binding: { ...decision.binding } }),
        ...(requestId === null ? {} : { requestId }),
      },
    };
    await this.deps.eventBus.publish(audit);

    switch (decision.kind) {
      case 'CLEARED':
        return { kind: 'CLEARED', requestId };
      case 'REVIEW':
        return { kind: 'REVIEW_REQUIRED', reasons: decision.reasons, requestId };
      case 'CORRECTION_NEEDED':
        return { kind: 'CORRECTION_NEEDED', code: decision.code, fields: decision.binding, requestId };
    }
  }
}
