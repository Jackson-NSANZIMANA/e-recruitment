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

import type { Agency, ApplicationStatus } from '@usrp/shared-types';
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

export interface MedicalReviewInput {
  readonly actor: OfficerActor;
  readonly applicationId: string;
  readonly fitnessStatus: 'FIT' | 'UNFIT';
}

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

export interface OfficerTransitionRepository {
  medicalReview(input: MedicalReviewInput): Promise<OfficerTransitionOutcome>;
  finalDecision(input: FinalDecisionInput): Promise<OfficerTransitionOutcome>;
  accept(input: AcceptInput): Promise<OfficerTransitionOutcome>;
}
