// ══════════════════════════════════════════════════════════════════
// application-service — ApplicationRepository port
//
// Persists a new application into the OWNING agency's isolated ops schema
// (rdf_ops / rnp_ops / rcs_ops). One transaction does three things
// atomically: mint the per-agency processing code from that schema's
// sequence, INSERT the applications row (status SUBMITTED), and INSERT the
// initial null→SUBMITTED application_status_history row (the immutable
// trail's first entry). All as usrp_system_service.
// ══════════════════════════════════════════════════════════════════

import type {
  AcademicEligibilityStatus,
  AgeEligibilityStatus,
  Agency,
  ApplicationCategory,
  ApplicationChannel,
  ApplicationStatus,
  CriminalClearanceStatus,
} from '@usrp/shared-types';

/** Everything needed to file one application under a resolved campaign. */
export interface CreateApplicationInput {
  readonly agency: Agency;
  readonly applicantId: string;
  readonly campaignId: string;
  readonly category: ApplicationCategory;
  readonly channel: ApplicationChannel;
  readonly nesaIndexNumber: string | null;
  readonly hecRegistrationNumber: string | null;
  /** Correlation id of the causal chain — recorded on the history row. */
  readonly correlationId: string;
}

/** Identifiers of the created application. */
export interface CreateApplicationResult {
  readonly applicationId: string;
  readonly processingCode: string;
}

// ── Vetting-result projection ─────────────────────────────────────
//
// One verdict dimension to materialise onto an application row. The `agency`
// selects the ops schema (the isolation boundary); the projection reads the
// row FOR UPDATE, applies the column, recomputes the lifecycle status, and —
// only when the top-level status actually transitions — appends a history row.

/** An academic verdict from NESA or HEC. */
export interface AcademicVettingResult {
  readonly dimension: 'ACADEMIC';
  readonly applicationId: string;
  readonly agency: Agency;
  readonly academicStatus: AcademicEligibilityStatus;
  /** Which registry produced it — selects the nesa_/hec_ verified columns. */
  readonly verifiedVia: 'NESA' | 'HEC';
  /** G2G request id for cross-system tracing (nesa_/hec_verification_request_id). */
  readonly requestId: string;
  /** The gate's EligibilityResult, stored verbatim in academic_eligibility_detail. */
  readonly detail: unknown;
  readonly correlationId: string;
}

/** An age-eligibility verdict from the age gate. */
export interface AgeVettingResult {
  readonly dimension: 'AGE';
  readonly applicationId: string;
  readonly agency: Agency;
  readonly ageStatus: AgeEligibilityStatus;
  /** DOB-free evidence, stored verbatim in age_eligibility_detail (never the DOB). */
  readonly detail: unknown;
  readonly correlationId: string;
}

/** A criminal-clearance verdict from RIB. */
export interface CriminalVettingResult {
  readonly dimension: 'CRIMINAL';
  readonly applicationId: string;
  readonly agency: Agency;
  readonly criminalStatus: CriminalClearanceStatus;
  /** The applied threshold — persisted for RNP only (applied_criminal_threshold). */
  readonly appliedThreshold: string;
  readonly ribRequestId: string;
  readonly correlationId: string;
}

export type VettingResult = AgeVettingResult | AcademicVettingResult | CriminalVettingResult;

/** Outcome of projecting one verdict onto an application row. */
export type ApplyVettingOutcome =
  | {
      readonly kind: 'APPLIED';
      readonly dimension: 'AGE' | 'ACADEMIC' | 'CRIMINAL';
      readonly fromStatus: ApplicationStatus;
      readonly toStatus: ApplicationStatus;
      /** True when the top-level status enum transitioned (a history row was written). */
      readonly statusChanged: boolean;
      /** Owning applicant + campaign + category, read off the row — needed to emit downstream triggers. */
      readonly applicantId: string;
      readonly campaignId: string;
      readonly category: ApplicationCategory;
    }
  /** The row was already in the target state — nothing written (idempotent redelivery). */
  | { readonly kind: 'NO_CHANGE' }
  /** No such application in the agency's schema — the cross-agency write guard. */
  | { readonly kind: 'NOT_FOUND' };

// ── Slot-assignment projection ─────────────────────────────────────
//
// A scheduling verdict (SLOT_ASSIGNED) to materialise onto an application row.
// Unlike the vetting dimensions, this is a post-eligibility STAGE transition
// (DOCUMENT_REVIEW_GREEN → SLOT_ASSIGNED), not a verdict folded into the pure
// vetting lifecycle — so it has its own repository method and only advances a
// row that is currently at the green terminal.

/** A venue/slot assignment from scheduling-service. */
export interface SlotAssignmentResult {
  readonly applicationId: string;
  readonly agency: Agency;
  readonly venueAssignmentId: string;
  readonly assignedDistrict: string;
  readonly assignedVenueName: string;
  /** Exam date (YYYY-MM-DD) — stamped as physical_test_scheduled_at. */
  readonly examDate: string;
  readonly qrInvitationCode: string;
  readonly correlationId: string;
}

/** Outcome of projecting a slot assignment onto an application row. */
export type ApplySlotOutcome =
  | {
      readonly kind: 'APPLIED';
      readonly fromStatus: ApplicationStatus;
      readonly toStatus: 'SLOT_ASSIGNED';
      readonly applicantId: string;
    }
  /** Already SLOT_ASSIGNED — idempotent redelivery, nothing written. */
  | { readonly kind: 'NO_CHANGE' }
  /**
   * The row is not at DOCUMENT_REVIEW_GREEN (not yet cleared, already past this
   * stage, or terminal) — a slot cannot be assigned now; nothing written.
   */
  | { readonly kind: 'NOT_ASSIGNABLE'; readonly currentStatus: ApplicationStatus }
  /** No such application in the agency's schema — the cross-agency write guard. */
  | { readonly kind: 'NOT_FOUND' };

/** The delivery outcome of the slot invitation, projected onto the row. */
export interface NotificationDeliveryResult {
  readonly applicationId: string;
  readonly agency: Agency;
  readonly deliveryStatus: 'DELIVERED' | 'PENDING_NO_CONTACT' | 'FAILED';
  readonly correlationId: string;
}

/** Outcome of projecting an invitation delivery onto an application row. */
export type ApplyNotificationOutcome =
  | {
      readonly kind: 'APPLIED';
      readonly fromStatus: 'SLOT_ASSIGNED';
      readonly toStatus: 'PHYSICAL_TEST_SCHEDULED';
      readonly applicantId: string;
    }
  /** Already at/after PHYSICAL_TEST_SCHEDULED — idempotent; sms_* status refreshed only. */
  | { readonly kind: 'NO_CHANGE' }
  /** Row not yet SLOT_ASSIGNED (or terminal/withdrawn) — cannot schedule; nothing written. */
  | { readonly kind: 'NOT_APPLICABLE'; readonly currentStatus: ApplicationStatus }
  /** No such application in the agency's schema — the cross-agency write guard. */
  | { readonly kind: 'NOT_FOUND' };

// ── Physical-test-complete projection ──────────────────────────────
//
// A device-signed field score was accepted by field-sync-service (ADR-010),
// which emitted FIELD_SCORE_CAPTURED. This advances the STAGE transition
// PHYSICAL_TEST_SCHEDULED → PHYSICAL_TEST_COMPLETE and stamps the winning score
// row. The event carries the metrics hash (not the row id), so the accepted
// score row is resolved by signed_payload_hash within the owning schema.

/** A captured field score to materialise onto an application row. */
export interface PhysicalTestCompleteResult {
  readonly applicationId: string;
  readonly agency: Agency;
  /** SHA-256 of the accepted record's metrics — locates the score row to stamp. */
  readonly signedPayloadHash: string;
  readonly correlationId: string;
}

/** Outcome of projecting a captured field score onto an application row.
 *  Two lanes share the projection (the row's own is_walk_in decides):
 *  scheduled digital rows complete PHYSICAL_TEST_SCHEDULED → COMPLETE;
 *  walk-in rows advance WALK_IN_ON_SITE_VETTING → WALK_IN_PHYSICAL_TEST
 *  (ADR-012). */
export type ApplyPhysicalTestOutcome =
  | {
      readonly kind: 'APPLIED';
      readonly fromStatus: 'PHYSICAL_TEST_SCHEDULED' | 'WALK_IN_ON_SITE_VETTING';
      readonly toStatus: 'PHYSICAL_TEST_COMPLETE' | 'WALK_IN_PHYSICAL_TEST';
      readonly applicantId: string;
      readonly physicalTestScoreId: string;
    }
  /** Already at/after PHYSICAL_TEST_COMPLETE — idempotent redelivery, nothing written. */
  | { readonly kind: 'NO_CHANGE' }
  /** Row not yet PHYSICAL_TEST_SCHEDULED (or terminal/withdrawn) — held; nothing written. */
  | { readonly kind: 'NOT_APPLICABLE'; readonly currentStatus: ApplicationStatus }
  /**
   * An unresolved concurrent-capture conflict is flagged on this application's
   * score rows — do NOT complete on any single score until an officer
   * adjudicates (ADR-010 §3). A deliberate HOLD that makes "never silently pick
   * an official score" an engine guarantee, independent of event ordering.
   */
  | { readonly kind: 'CONFLICT_HELD' }
  /**
   * Biometric check-in precondition unmet (applicant_identities.biometric_verified_at
   * is null) — no physical-test completion for a check-in that failed biometrics.
   * A deliberate HOLD, not an error.
   */
  | { readonly kind: 'BIOMETRIC_NOT_VERIFIED' }
  /** No stored score row matches the event's payload hash in this schema. */
  | { readonly kind: 'SCORE_NOT_FOUND' }
  /** No such application in the agency's schema — the cross-agency write guard. */
  | { readonly kind: 'NOT_FOUND' };

// ── Forensics-routing projection ────────────────────────────────────
//
// A document forensics verdict (document-forensics-service) routed onto the
// application status (ADR-011). Lane policy, applied against the row's
// CURRENT position in the canonical order:
//   RED   — hostile/forged document. Before SLOT_ASSIGNED → REJECTED
//           (autonomous fail-closed, mirrors the vetting hard-fail); at/past
//           SLOT_ASSIGNED → ADJUDICATION_REVIEW (late adverse signal on a
//           cleared applicant gets a human, same as late vetting flags).
//   AMBER — routine document review. Before AMBER's own rank →
//           DOCUMENT_REVIEW_AMBER (the officer amber queue); at/past
//           SLOT_ASSIGNED → ADJUDICATION_REVIEW; already AMBER → NO_CHANGE.
//   GREEN — the verdict lives in document_records; the status never moves.

/** A document forensics verdict to route onto an application row. */
export interface ForensicsRoutingResult {
  readonly applicationId: string;
  readonly agency: Agency;
  readonly lane: 'GREEN' | 'AMBER' | 'RED';
  readonly documentId: string;
  readonly correlationId: string;
}

/** Outcome of routing a forensics verdict onto an application row. */
export type ApplyForensicsOutcome =
  | {
      readonly kind: 'APPLIED';
      readonly fromStatus: ApplicationStatus;
      readonly toStatus: ApplicationStatus;
      readonly applicantId: string;
    }
  /** Verdict recorded but no status transition is due (GREEN, or already routed). */
  | { readonly kind: 'NO_CHANGE' }
  /** Terminal/withdrawn row — nothing to route; nothing written. */
  | { readonly kind: 'NOT_APPLICABLE'; readonly currentStatus: ApplicationStatus }
  /** No such application in the agency's schema — the cross-agency write guard. */
  | { readonly kind: 'NOT_FOUND' };

export interface ApplicationRepository {
  createApplication(input: CreateApplicationInput): Promise<CreateApplicationResult>;
  /**
   * Project one vetting verdict onto its application row within the owning
   * agency's ops schema, in one transaction. Idempotent: a redelivered verdict
   * that changes nothing returns NO_CHANGE without writing. An application_id
   * absent from that agency's schema returns NOT_FOUND (never a silent success).
   */
  applyVettingResult(result: VettingResult): Promise<ApplyVettingOutcome>;
  /**
   * Stamp a venue/slot assignment onto its application row and advance
   * DOCUMENT_REVIEW_GREEN → SLOT_ASSIGNED, in one transaction. Only assignable
   * from the green terminal (NOT_ASSIGNABLE otherwise); idempotent on redelivery
   * (NO_CHANGE); cross-agency guarded (NOT_FOUND).
   */
  applySlotAssignment(result: SlotAssignmentResult): Promise<ApplySlotOutcome>;
  /**
   * Record the slot-invitation delivery outcome and advance SLOT_ASSIGNED →
   * PHYSICAL_TEST_SCHEDULED, in one transaction. Only applicable from
   * SLOT_ASSIGNED (NOT_APPLICABLE otherwise); idempotent on redelivery
   * (NO_CHANGE — refreshes sms_notification_* only); cross-agency guarded
   * (NOT_FOUND). Lifecycle advance is independent of deliveryStatus: the test
   * is scheduled whether or not the channel reached the applicant.
   */
  applyNotificationDelivery(result: NotificationDeliveryResult): Promise<ApplyNotificationOutcome>;
  /**
   * Advance PHYSICAL_TEST_SCHEDULED → PHYSICAL_TEST_COMPLETE and stamp the
   * accepted field score (resolved by signed_payload_hash), in one transaction.
   * Enforces the biometric-pass precondition (BIOMETRIC_NOT_VERIFIED holds the
   * row); only applicable from PHYSICAL_TEST_SCHEDULED (NOT_APPLICABLE
   * otherwise); idempotent on redelivery (NO_CHANGE); cross-agency guarded
   * (NOT_FOUND). Never advances on a conflicted score — field-sync emits
   * FIELD_SCORE_CAPTURED only for a clean/resolved record.
   */
  applyPhysicalTestComplete(
    result: PhysicalTestCompleteResult,
  ): Promise<ApplyPhysicalTestOutcome>;
  /**
   * Route a document forensics verdict onto its application row (ADR-011 lane
   * policy above), in one transaction. Monotonic and hold-safe: GREEN never
   * moves the status, AMBER holds pre-slot rows at DOCUMENT_REVIEW_AMBER, RED
   * rejects pre-slot and adjudicates post-slot; idempotent on redelivery
   * (NO_CHANGE); terminal rows untouched (NOT_APPLICABLE); cross-agency
   * guarded (NOT_FOUND).
   */
  applyForensicsRouting(result: ForensicsRoutingResult): Promise<ApplyForensicsOutcome>;
}
