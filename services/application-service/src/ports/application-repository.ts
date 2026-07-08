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

export type VettingResult = AcademicVettingResult | CriminalVettingResult;

/** Outcome of projecting one verdict onto an application row. */
export type ApplyVettingOutcome =
  | {
      readonly kind: 'APPLIED';
      readonly dimension: 'ACADEMIC' | 'CRIMINAL';
      readonly fromStatus: ApplicationStatus;
      readonly toStatus: ApplicationStatus;
      /** True when the top-level status enum transitioned (a history row was written). */
      readonly statusChanged: boolean;
    }
  /** The row was already in the target state — nothing written (idempotent redelivery). */
  | { readonly kind: 'NO_CHANGE' }
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
}
