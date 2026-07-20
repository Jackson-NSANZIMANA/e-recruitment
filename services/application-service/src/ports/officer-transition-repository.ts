// ══════════════════════════════════════════════════════════════════
// application-service — OfficerTransitionRepository port
//
// The officer-driven half of the application lifecycle: the three human
// write transitions that carry a submission the rest of the green digital
// lane — PHYSICAL_TEST_COMPLETE → MEDICAL_REVIEW → FINAL_SHORTLIST → ACCEPTED
// (and REJECTED off the medical/final gates).
//
// Unlike the autonomous projections (vetting/slot/notification/field-score),
// which run as usrp_system_service, these run as the OFFICER's own DB role
// (usrp_<agency>_officer) — the first production WRITE path to do so. The
// agency comes from the verified token, so the transaction can only ever
// touch the officer's own ops schema; a sibling schema would raise
// permission-denied (cross-agency isolation enforced by the DB engine, not
// merely app code). rls/0001 grants the officer role SELECT/INSERT/UPDATE on
// its ops schema; rls/0007 keeps status-history append-only (officer may
// INSERT a history row, never mutate one).
// ══════════════════════════════════════════════════════════════════

import type { Agency, ApplicationCategory, ApplicationStatus } from '@usrp/shared-types';
import type { DbRole } from '@usrp/shared-auth';

/**
 * Shared identity for an officer-driven command. `agency` + `dbRole` come from
 * the verified token, never the request body, so the write is scoped to the
 * officer's own schema. `officerId` is the officer's UUID subject — stamped
 * onto the `*_by_id` column and attributed on the audit trail. `correlationId`
 * threads the causal chain onto the history + audit records.
 */
export interface OfficerActor {
  readonly agency: Agency;
  readonly dbRole: DbRole;
  readonly officerId: string;
  readonly correlationId: string;
}

/**
 * Medical review is the one transition the three agencies genuinely do
 * differently (ADR-013), so the input is a union discriminated by mode:
 *   • BOARD (RDF) — an in-house medical board records a fitness verdict;
 *     stamps medical_reviewed_by_id/_at + medical_fitness_status (rdf_ops-only
 *     columns).
 *   • CERTIFICATE (RNP, RCS) — an officer verifies a government-physician
 *     certificate brought by the applicant; CERT_VERIFIED stamps
 *     medical_cert_verified/_verified_at/_physician_name (mirrored on both
 *     schemas by rls/0012). CERT_REJECTED stamps nothing — the REJECTED
 *     status + append-only history row ARE the record of the decision, and
 *     `medical_cert_verified=false` stays honest ("never verified", not
 *     "verified false at time T").
 * The MODE is derived from the verified principal's agency by the use case —
 * never from the request body.
 */
export interface MedicalReviewBoardInput {
  readonly actor: OfficerActor;
  readonly applicationId: string;
  readonly mode: 'BOARD';
  readonly fitnessStatus: 'FIT' | 'UNFIT';
}

export interface MedicalReviewCertificateInput {
  readonly actor: OfficerActor;
  readonly applicationId: string;
  readonly mode: 'CERTIFICATE';
  readonly certVerdict: 'CERT_VERIFIED' | 'CERT_REJECTED';
  /** Required (non-empty, ≤200 chars) when CERT_VERIFIED; null when rejected. */
  readonly physicianName: string | null;
}

export type MedicalReviewInput = MedicalReviewBoardInput | MedicalReviewCertificateInput;

export interface FinalDecisionInput {
  readonly actor: OfficerActor;
  readonly applicationId: string;
  readonly decision: 'SHORTLIST' | 'REJECT';
  readonly notes: string | null;
}

export interface AcceptInput {
  readonly actor: OfficerActor;
  readonly applicationId: string;
}

export interface AdjudicateInput {
  readonly actor: OfficerActor;
  readonly applicationId: string;
  readonly decision: 'CLEAR' | 'REJECT';
  readonly notes: string | null;
}

/**
 * Outcome of an officer transition. APPLIED is the only mutating result.
 *   • NO_CHANGE      — idempotent re-apply: the row is already AT the target
 *                      (a double-submit of the same command).
 *   • NOT_APPLICABLE — hold-safe: the row is not at the required prior status
 *                      (acting out of order, or already advanced past).
 *   • NOT_FOUND      — the application is absent from the officer's OWN agency
 *                      schema; the cross-agency guard (an RDF officer acting on
 *                      an RNP application sees nothing).
 * All three non-APPLIED results are no-ops (no write, no audit).
 */
export type OfficerTransitionOutcome =
  | { readonly kind: 'APPLIED'; readonly fromStatus: ApplicationStatus; readonly toStatus: ApplicationStatus }
  | { readonly kind: 'NO_CHANGE'; readonly currentStatus: ApplicationStatus }
  | { readonly kind: 'NOT_APPLICABLE'; readonly currentStatus: ApplicationStatus }
  | { readonly kind: 'NOT_FOUND' };

/**
 * Outcome of an officer adjudication (ADR-011). Extends the transition shape:
 * a CLEAR that re-derives to DOCUMENT_REVIEW_GREEN must let the use case emit
 * application.cleared (the slot lane's trigger), so APPLIED carries the
 * row-read identifiers the event needs, plus whether GREEN was reached.
 */
export type AdjudicateOutcome =
  | {
      readonly kind: 'APPLIED';
      readonly fromStatus: ApplicationStatus;
      readonly toStatus: ApplicationStatus;
      /** True exactly when CLEAR restored the row to DOCUMENT_REVIEW_GREEN. */
      readonly clearedToGreen: boolean;
      readonly applicantId: string;
      readonly campaignId: string;
      readonly category: ApplicationCategory;
    }
  | { readonly kind: 'NO_CHANGE'; readonly currentStatus: ApplicationStatus }
  | { readonly kind: 'NOT_APPLICABLE'; readonly currentStatus: ApplicationStatus }
  | { readonly kind: 'NOT_FOUND' };

export interface OfficerTransitionRepository {
  medicalReview(input: MedicalReviewInput): Promise<OfficerTransitionOutcome>;
  finalDecision(input: FinalDecisionInput): Promise<OfficerTransitionOutcome>;
  accept(input: AcceptInput): Promise<OfficerTransitionOutcome>;
  /**
   * Adjudicate an application held at DOCUMENT_REVIEW_AMBER (routine document
   * review) or ADJUDICATION_REVIEW (late-disqualification hold), as the
   * officer's DB role, in one transaction:
   *   • REJECT — → REJECTED; on an AMBER hold, stamps the un-reviewed AMBER
   *     document_records rows human_reviewed_by_id/_at/_decision.
   *   • CLEAR from DOCUMENT_REVIEW_AMBER — the document hold is lifted; the
   *     status RE-DERIVES from the row's vetting evidence (pure lifecycle,
   *     baseline SUBMITTED): all-pass → DOCUMENT_REVIEW_GREEN
   *     (clearedToGreen=true), partial evidence → the furthest vetting stage
   *     (never a premature green for an app whose gates haven't answered).
   *     Stamps the AMBER document rows 'CLEAR'.
   *   • CLEAR from ADJUDICATION_REVIEW — restores the stage the row held when
   *     the late flag arrived (last from_status into ADJUDICATION_REVIEW on
   *     the append-only history); no document stamp (not a document decision).
   * Any other status → NOT_APPLICABLE. Idempotent/hold-safe/cross-agency
   * guarded exactly like the other officer transitions.
   */
  adjudicate(input: AdjudicateInput): Promise<AdjudicateOutcome>;
}
