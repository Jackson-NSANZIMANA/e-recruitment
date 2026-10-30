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
import type { AdjudicationLane } from '../domain/adjudication-lanes.js';

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
  /**
   * WHICH hold this verdict is about (evaluation D10). Omitted = "the row's only
   * hold": the queue shows rows held in up to three lanes (see
   * domain/adjudication-lanes.ts), and only the officer can say which one they
   * are deciding when a row is in more than one. A lane the row is not held in
   * is refused, with `heldLanes` naming the ones that are.
   */
  readonly lane?: AdjudicationLane;
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
 *   • CROSS_AGENCY_LOCKED — accept refused because this citizen is already
 *                      accepted (ADR-014): the shared identity row carries a
 *                      cross_agency_lock stamped by `lockedByAgency` — which
 *                      may be a sibling agency OR the officer's own (a second
 *                      application of the same person). The transaction rolls
 *                      back whole: no ACCEPTED write, no history row.
 * All non-APPLIED results are no-ops (no write, no audit).
 */
export type OfficerTransitionOutcome =
  | { readonly kind: 'APPLIED'; readonly fromStatus: ApplicationStatus; readonly toStatus: ApplicationStatus }
  | { readonly kind: 'NO_CHANGE'; readonly currentStatus: ApplicationStatus }
  | {
      readonly kind: 'NOT_APPLICABLE';
      readonly currentStatus: ApplicationStatus;
      /** Adjudication only (evaluation D10): the lanes the row IS held in. */
      readonly heldLanes?: readonly AdjudicationLane[];
    }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'CROSS_AGENCY_LOCKED'; readonly lockedByAgency: Agency }
  | SeparationOfDutiesOutcome;

/**
 * Four-eyes refusal (BUILD-004 §D): the permission to act was held, but this
 * SAME officer already performed the preceding step on THIS application. A
 * hold-safe no-op — nothing written, nothing audited as a transition. `rule`
 * is a closed identifier, never a person.
 */
export interface SeparationOfDutiesOutcome {
  readonly kind: 'SEPARATION_OF_DUTIES';
  readonly rule: 'FINAL_DECISION_EXCLUDES_MEDICAL_REVIEWER' | 'ACCEPT_EXCLUDES_FINAL_DECIDER';
}

/**
 * Outcome of an officer acceptance. Same shape as the generic transition, but
 * APPLIED additionally carries the row-read identifiers the use case needs to
 * publish APPLICATION_ACCEPTED (ADR-017's auto-withdrawal trigger) — mirroring
 * how AdjudicateOutcome feeds application.cleared.
 */
export type AcceptOutcome =
  | {
      readonly kind: 'APPLIED';
      readonly fromStatus: ApplicationStatus;
      readonly toStatus: ApplicationStatus;
      readonly applicantId: string;
      readonly campaignId: string;
      readonly category: ApplicationCategory;
    }
  | { readonly kind: 'NO_CHANGE'; readonly currentStatus: ApplicationStatus }
  | { readonly kind: 'NOT_APPLICABLE'; readonly currentStatus: ApplicationStatus }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'CROSS_AGENCY_LOCKED'; readonly lockedByAgency: Agency }
  | SeparationOfDutiesOutcome;

/**
 * Outcome of an officer adjudication (ADR-011). Extends the transition shape:
 * a CLEAR that re-derives to DOCUMENT_REVIEW_GREEN must let the use case emit
 * application.cleared (the slot lane's trigger), so APPLIED carries the
 * row-read identifiers the event needs, plus whether GREEN was reached.
 */
export type AdjudicateOutcome =
  | {
      readonly kind: 'APPLIED';
      /** The lane this verdict decided (whatever the row's other holds are). */
      readonly lane: AdjudicationLane;
      readonly fromStatus: ApplicationStatus;
      /**
       * Where the row landed. EQUAL to `fromStatus` when the decision was
       * recorded but another lane still holds the row: a criminal verdict does
       * not lift a document hold, so the top-level status only moves when the
       * decision removes the LAST hold.
       */
      readonly toStatus: ApplicationStatus;
      /** True exactly when CLEAR restored the row to DOCUMENT_REVIEW_GREEN. */
      readonly clearedToGreen: boolean;
      readonly applicantId: string;
      readonly campaignId: string;
      readonly category: ApplicationCategory;
    }
  | { readonly kind: 'NO_CHANGE'; readonly currentStatus: ApplicationStatus }
  | {
      readonly kind: 'NOT_APPLICABLE';
      readonly currentStatus: ApplicationStatus;
      /**
       * The lanes the row IS held in — empty when nothing here needs a human.
       * Carried so the refusal can be explained instead of shrugged at.
       */
      readonly heldLanes: readonly AdjudicationLane[];
    }
  | { readonly kind: 'NOT_FOUND' };

export interface OfficerTransitionRepository {
  medicalReview(input: MedicalReviewInput): Promise<OfficerTransitionOutcome>;
  finalDecision(input: FinalDecisionInput): Promise<OfficerTransitionOutcome>;
  accept(input: AcceptInput): Promise<AcceptOutcome>;
  /**
   * Adjudicate an application held in ONE of the three lanes
   * (domain/adjudication-lanes.ts), as the officer's DB role, in one
   * transaction. DOCUMENT covers DOCUMENT_REVIEW_AMBER (routine document
   * review) and ADJUDICATION_REVIEW (late-disqualification hold):
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
   *   • CRIMINAL (evaluation D10) — the row's criminal gate is UNDER_REVIEW:
   *     CLEAR records `criminal_clearance_status = CLEARED` (+ `criminal_clearance_at`),
   *     REJECT → REJECTED. ACADEMIC — the NESA hold (`academic_status = PENDING`
   *     with `failureCode = NESA_REVIEW_REQUIRED`): CLEAR records the gate as
   *     ELIGIBLE, REJECT → REJECTED.
   *     A REJECT is a decision about the APPLICATION, never a verdict about the
   *     dimension: the registry said "a human must judge", not "guilty", so the
   *     dimension column is left as the evidence left it.
   * A row held in no lane, or in a lane the caller did not name (and does not
   * have exactly one of), → NOT_APPLICABLE with `heldLanes`.
   * Idempotent/hold-safe/cross-agency guarded exactly like the other officer
   * transitions.
   */
  adjudicate(input: AdjudicateInput): Promise<AdjudicateOutcome>;
}
