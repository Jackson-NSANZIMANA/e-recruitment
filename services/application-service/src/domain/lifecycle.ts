// ══════════════════════════════════════════════════════════════════
// application-service — Application lifecycle composition (pure domain)
//
// The projection's decision core. Given the application's CURRENT top-level
// status and its (post-update) per-dimension verdicts — age + academic +
// criminal — compute the next top-level `status`. Pure and total: no I/O, no
// clock, no throw, so the whole lifecycle policy is unit-testable in isolation.
//
// Design invariants:
//   • MONOTONIC — status never regresses. The three vetting gates run in
//     PARALLEL (all off APPLICANT_SUBMITTED), so results arrive in any order
//     and may be redelivered; the top-level status is the FURTHEST stage
//     justified by the evidence so far, computed by max-rank, never a step back.
//   • FAIL-CLOSED — a hard fail (age INELIGIBLE, academic INELIGIBLE, or any
//     criminal FLAGGED_*) while still in the vetting ladder drives the
//     application to REJECTED (terminal); a LATE hard fail on a row at or past
//     SLOT_ASSIGNED routes to ADJUDICATION_REVIEW for human adjudication
//     instead (ADR-011). Criminal UNDER_REVIEW is a HOLD, not a fail: it
//     reaches the criminal stage but does not reject (awaits human adjudication).
//   • POSITIVE TERMINAL — the three gates together answer the whole eligibility
//     question. When ALL pass (age ELIGIBLE, academic ELIGIBLE, criminal
//     CLEARED) the application advances to DOCUMENT_REVIEW_GREEN — the green
//     lane, everything auto-verified via G2G. Age has no intermediate ladder
//     rung of its own (there is no such ApplicationStatus): it is a precondition
//     gate that can hard-fail and is required for the green terminal.
//
// The verdict enums (AgeEligibilityStatus, AcademicEligibilityStatus,
// CriminalClearanceStatus) are value-identical to the DB column enums
// (age_eligibility_status, academic_eligibility_status, criminal_clearance_status)
// by deliberate design in @usrp/shared-types, so the projection stores them
// directly — no translation layer.
// ══════════════════════════════════════════════════════════════════

import { APPLICATION_STATUSES } from '@usrp/shared-types';
import type {
  AcademicEligibilityStatus,
  AgeEligibilityStatus,
  ApplicationStatus,
  CriminalClearanceStatus,
} from '@usrp/shared-types';

/** Post-update per-dimension verdicts read off the application row. */
export interface VettingEvidence {
  readonly ageStatus: AgeEligibilityStatus;
  readonly academicStatus: AcademicEligibilityStatus;
  readonly criminalStatus: CriminalClearanceStatus;
}

/** Statuses this projection will never move away from once reached. */
const TERMINAL: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  'REJECTED',
  'WITHDRAWN',
  'ACCEPTED',
  'WALK_IN_REJECTED',
]);

/** Criminal verdicts that are a hard, disqualifying fail (not a hold). */
const CRIMINAL_HARD_FAIL: ReadonlySet<CriminalClearanceStatus> = new Set<CriminalClearanceStatus>([
  'FLAGGED_CONVICTION',
  'FLAGGED_PROSECUTION',
  'FLAGGED_DISMISSED',
]);

/**
 * Monotonicity rank = position in the CANONICAL lifecycle order
 * (@usrp/shared-types APPLICATION_STATUSES), the single source of truth for how
 * far along a status is. This projection only ever proposes candidates up to
 * DOCUMENT_REVIEW_GREEN, but a row may already be FURTHER along (SLOT_ASSIGNED,
 * PHYSICAL_TEST_SCHEDULED, …) when a vetting event is redelivered — so the rank
 * must know the full order, not just the vetting ladder. Ranking a downstream
 * status against a short local ladder (indexOf → -1) is exactly what let a
 * redelivered all-pass event regress a scheduled applicant back to GREEN.
 */
function stageRank(status: ApplicationStatus): number {
  return APPLICATION_STATUSES.indexOf(status);
}

function isHardFail(evidence: VettingEvidence): boolean {
  return (
    evidence.ageStatus === 'INELIGIBLE' ||
    evidence.academicStatus === 'INELIGIBLE' ||
    CRIMINAL_HARD_FAIL.has(evidence.criminalStatus)
  );
}

/** True when all three gates have positively passed — the green-lane condition. */
function allGatesPassed(evidence: VettingEvidence): boolean {
  return (
    evidence.ageStatus === 'ELIGIBLE' &&
    evidence.academicStatus === 'ELIGIBLE' &&
    evidence.criminalStatus === 'CLEARED'
  );
}

/**
 * Compute the next top-level application status from the current status and the
 * (already-applied) per-dimension verdicts. Returns `current` unchanged when no
 * transition is justified — the caller uses equality to decide whether to write
 * a status-history row.
 */
export function deriveApplicationStatus(
  current: ApplicationStatus,
  evidence: VettingEvidence,
): ApplicationStatus {
  // Terminal states are never left by the projection.
  if (TERMINAL.has(current)) return current;

  // A hard fail is fail-closed, but WHERE it lands depends on how far the row
  // has progressed (ADR-011, owner-decided 2026-07-14 — settles the policy
  // previously parked here):
  //   • still in the vetting ladder (before SLOT_ASSIGNED) → REJECTED, the
  //     pre-existing autonomous fail-closed behaviour, unchanged;
  //   • at or past SLOT_ASSIGNED (a LATE verdict on an already-cleared,
  //     scheduled applicant — e.g. a late criminal flag) → ADJUDICATION_REVIEW,
  //     a human-adjudication hold. Auto-rejecting a cleared applicant off the
  //     backbone gave no human a say; now an officer CLEARs (restores) or
  //     REJECTs via the adjudicate endpoint. ADJUDICATION_REVIEW ranks above
  //     every in-flight stage, so redelivered evidence can never move the row
  //     out of the hold — only the officer path exits it.
  if (isHardFail(evidence)) {
    // Walk-in lane (ADR-012): the same early-vs-late rule, but with the lane's
    // own geography. WALK_IN_* ranks AFTER the digital ladder in the canonical
    // order (a parallel entry ramp, not a later stage), so the SLOT_ASSIGNED
    // rank test above would misread a freshly registered walk-in as "late".
    // The walk-in eligibility terminal is the on-site vetting gate:
    //   • at WALK_IN_REGISTERED (gates still running) → WALK_IN_REJECTED, the
    //     lane's own autonomous fail-closed terminal;
    //   • at/past WALK_IN_ON_SITE_VETTING (vetted on-site, testing or tested —
    //     a LATE verdict) → ADJUDICATION_REVIEW, same human hold as the ladder.
    if (current === 'WALK_IN_REGISTERED') return 'WALK_IN_REJECTED';
    if (current === 'WALK_IN_ON_SITE_VETTING' || current === 'WALK_IN_PHYSICAL_TEST') {
      return 'ADJUDICATION_REVIEW';
    }
    return stageRank(current) >= stageRank('SLOT_ASSIGNED')
      ? 'ADJUDICATION_REVIEW'
      : 'REJECTED';
  }

  // Otherwise advance to the furthest stage the evidence justifies — but only
  // upward, and only within the linear ladder. All three gates passing is the
  // furthest: it reaches the positive terminal (green lane). Below that, the
  // stage tracks the deepest vetting dimension that has produced a verdict.
  const candidate: ApplicationStatus = allGatesPassed(evidence)
    ? 'DOCUMENT_REVIEW_GREEN'
    : evidence.criminalStatus !== 'PENDING'
      ? 'CRIMINAL_CLEARANCE'
      : evidence.academicStatus !== 'PENDING'
        ? 'ACADEMIC_VETTING'
        : current;

  const currentRank = stageRank(current);
  const candidateRank = stageRank(candidate);
  return candidateRank > currentRank ? candidate : current;
}
