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
  /** ADR-049: the application's pinned clearance values; absent, the configured policy governs. */
  readonly policy?: { readonly allowedCertificateCodes: readonly string[]; readonly noRecordCertificateCodes: readonly string[]; readonly validityDays: number };
  readonly context?: EventContext;
}

export type VerifyClearanceCertificateOutcome =
  | { readonly kind: 'CLEARED'; readonly requestId: string | null }
  | { readonly kind: 'REVIEW_REQUIRED'; readonly reasons: readonly string[]; readonly requestId: string | null }
  | { readonly kind: 'CORRECTION_NEEDED'; readonly code: ClearanceFailureCode; readonly fields: BindingFields | null; readonly requestId: string | null }
  | { readonly kind: 'APPLICANT_NOT_FOUND'; readonly applicantId: string }
  | { readonly kind: 'IDENTITY_NOT_VERIFIED'; readonly applicantId: string };

/**
 * The terminal word on a certificate the registry never answered for.
 *
 * No reference date and no policy: nothing is being decided against the
 * certificate, only the fact that it could not be read automatically.
 */
export interface EscalateUnverifiedClearanceCommand {
  readonly applicantId: string;
  readonly applicationId: string;
  readonly agency: Agency;
  readonly category: ApplicationCategory;
  /** As carried by the event; only its HMAC and last 4 are ever persisted. */
  readonly clearanceCertificateNumber: string;
  readonly context?: EventContext;
}

/**
 * What `conclude` may be handed: a verdict from the pure rules — which always
 * read the certificate — or the escalation, which never did. Only the
 * certificate fields differ, and they are nullable in the table for exactly this
 * reason (`review_reasons` already says why a human is looking).
 */
type Conclusion =
  | ClearanceDecision
  | {
      readonly kind: 'REVIEW';
      readonly reasons: readonly ['CLEARANCE_UNVERIFIED'];
      readonly certificateType: null;
      readonly issuedOn: null;
      readonly binding: null;
    };

/** What a conclusion needs from its command: who, which application, which lane. */
type ConclusionSubject = Pick<
  VerifyClearanceCertificateCommand,
  'applicantId' | 'applicationId' | 'agency' | 'category'
>;

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
    const base = this.referenceOf(command, context);

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
      command.policy === undefined
        ? this.deps.policy
        : { allowedTypes: new Set(command.policy.allowedCertificateCodes), noRecordTypes: new Set(command.policy.noRecordCertificateCodes), validityDays: command.policy.validityDays },
      command.referenceDate,
    );
    return this.conclude(command, context, base, decision, lookup.requestId);
  }

  private hmac(value: string): string {
    return createHmac('sha256', this.deps.referenceHmacKey).update(value).digest('hex');
  }

  /**
   * The stored handle of a certificate number: an HMAC under the service key
   * plus its last 4. One place, because the escalation below MUST reproduce the
   * same handle as the PENDING record it supersedes — two normalisations that
   * drifted would split one certificate's history in two.
   *
   * A malformed number is held the same way: sanitised, so a bad producer
   * cannot make a poison message the partition re-reads forever.
   */
  private referenceOf(
    command: Pick<VerifyClearanceCertificateCommand, 'agency' | 'applicationId' | 'applicantId' | 'clearanceCertificateNumber'>,
    context: EventContext,
  ): Pick<ClearanceVerificationRecord, 'agency' | 'applicationId' | 'applicantId' | 'referenceHmac' | 'referenceLast4' | 'correlationId'> {
    const number = parseClearanceNumber(command.clearanceCertificateNumber);
    const referenceKey = number ?? command.clearanceCertificateNumber.trim().toUpperCase().replace(/[^A-Z0-9]/g, '*').slice(0, 64);
    return {
      agency: command.agency,
      applicationId: command.applicationId,
      applicantId: command.applicantId,
      referenceHmac: this.hmac(referenceKey),
      referenceLast4: referenceKey.slice(-4).padStart(4, '*'),
      correlationId: context.correlationId,
    };
  }

  /**
   * THE END OF THE LINE FOR A CERTIFICATE THE REGISTRY NEVER ANSWERED FOR
   * (evaluation D2). The retry budget is deliberately short — a stuck event must
   * not hold its partition hostage — so a registry outage longer than a few
   * seconds parks the event on the dead-letter topic. Re-driving that call from
   * durable state is impossible BY DESIGN: the certificate number is never
   * stored (`clearance_certificate_verifications` holds an HMAC and a last 4),
   * and keeping it so a timer could retry would trade a citizen's privacy for
   * our convenience.
   *
   * So the terminal outcome is not another attempt, it is a HUMAN: the
   * certificate is recorded as REVIEW with CLEARANCE_UNVERIFIED, which moves the
   * application into the amber queue and turns the citizen's "we are verifying"
   * into "an officer will look". Nothing is asserted about the certificate —
   * every certificate field stays null, and no failure code is written (a
   * REVIEW row may not carry one).
   *
   * Called from the bus's dead-letter observer, so it runs only after this
   * event's bytes are safely parked, and it is idempotent: the same escalation
   * twice is ALREADY_RECORDED.
   */
  async escalateUnverified(command: EscalateUnverifiedClearanceCommand): Promise<VerifyClearanceCertificateOutcome> {
    const context = command.context ?? newCorrelationContext();
    const base = this.referenceOf(command, context);
    // The reason is a member of the shared vocabulary (shared-types), so the
    // readers that rebuild the field against their allowlist accept it. Nothing
    // is asserted about the certificate itself: every certificate field is null.
    const decision: Conclusion = {
      kind: 'REVIEW',
      reasons: ['CLEARANCE_UNVERIFIED'],
      certificateType: null,
      issuedOn: null,
      binding: null,
    };
    return this.conclude(command, context, base, decision, null, 'CLEARANCE_VERIFICATION_ESCALATED');
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
    command: ConclusionSubject,
    context: EventContext,
    base: Pick<ClearanceVerificationRecord, 'agency' | 'applicationId' | 'applicantId' | 'referenceHmac' | 'referenceLast4' | 'correlationId'>,
    decision: Conclusion,
    requestId: string | null,
    auditAction?: string,
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
        auditAction ??
        (decision.kind === 'CLEARED'
          ? 'CLEARANCE_CERTIFICATE_PASSED'
          : decision.kind === 'REVIEW'
            ? 'CLEARANCE_CERTIFICATE_REVIEW_REQUIRED'
            : 'CLEARANCE_CERTIFICATE_CORRECTION_NEEDED'),
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
