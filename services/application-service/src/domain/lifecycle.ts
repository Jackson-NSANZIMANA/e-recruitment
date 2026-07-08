// ══════════════════════════════════════════════════════════════════
// application-service — Application lifecycle composition (pure domain)
//
// The projection's decision core. Given the application's CURRENT top-level
// status and its (post-update) per-dimension verdicts — academic + criminal —
// compute the next top-level `status`. Pure and total: no I/O, no clock, no
// throw, so the whole lifecycle policy is unit-testable in isolation.
//
// Design invariants:
//   • MONOTONIC — status never regresses. The vetting gates run in PARALLEL
//     (both off APPLICANT_SUBMITTED), so results arrive in any order and may be
//     redelivered; the top-level status is the FURTHEST stage justified by the
//     evidence so far, computed by max-rank, never a step backward.
//   • FAIL-CLOSED — a hard fail (academic INELIGIBLE, or any criminal FLAGGED_*)
//     drives the application to REJECTED (terminal), overriding stage progress.
//     UNDER_REVIEW is a HOLD, not a fail: it reaches the criminal stage but does
//     not reject (it awaits human adjudication).
//   • HONEST SEAM — this slice advances only as far as CRIMINAL_CLEARANCE. The
//     positive terminal ("all gates passed → DOCUMENT_REVIEW") needs the AGE
//     verdict too, and the age gate has no applicationId-bearing result event
//     yet. So we never declare "fully cleared" here — that is the next slice.
//
// The event verdict enums (AcademicEligibilityStatus, CriminalClearanceStatus)
// are value-identical to the DB column enums (academic_eligibility_status,
// criminal_clearance_status) by deliberate design in @usrp/shared-types, so the
// projection stores them directly — no translation layer.
// ══════════════════════════════════════════════════════════════════

import type {
  AcademicEligibilityStatus,
  ApplicationStatus,
  CriminalClearanceStatus,
} from '@usrp/shared-types';

/** Post-update per-dimension verdicts read off the application row. */
export interface VettingEvidence {
  readonly academicStatus: AcademicEligibilityStatus;
  readonly criminalStatus: CriminalClearanceStatus;
}

/** Statuses this projection will never move away from once reached. */
const TERMINAL: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  'REJECTED',
  'WITHDRAWN',
  'ACCEPTED',
]);

/** Criminal verdicts that are a hard, disqualifying fail (not a hold). */
const CRIMINAL_HARD_FAIL: ReadonlySet<CriminalClearanceStatus> = new Set<CriminalClearanceStatus>([
  'FLAGGED_CONVICTION',
  'FLAGGED_PROSECUTION',
  'FLAGGED_DISMISSED',
]);

/**
 * The linear vetting ladder this slice drives. Rank = index; a status not on
 * the ladder (downstream stages, walk-in path) has rank -1 → we do not advance
 * it (monotonicity is preserved: candidates never outrank an off-ladder status).
 */
const LADDER: readonly ApplicationStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'ACADEMIC_VETTING',
  'CRIMINAL_CLEARANCE',
];

function ladderRank(status: ApplicationStatus): number {
  return LADDER.indexOf(status);
}

function isHardFail(evidence: VettingEvidence): boolean {
  return evidence.academicStatus === 'INELIGIBLE' || CRIMINAL_HARD_FAIL.has(evidence.criminalStatus);
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

  // A hard fail rejects from any non-terminal state.
  if (isHardFail(evidence)) return 'REJECTED';

  // Otherwise advance to the furthest stage the evidence justifies — but only
  // upward, and only within the linear ladder.
  const candidate: ApplicationStatus =
    evidence.criminalStatus !== 'PENDING'
      ? 'CRIMINAL_CLEARANCE'
      : evidence.academicStatus !== 'PENDING'
        ? 'ACADEMIC_VETTING'
        : current;

  const currentRank = ladderRank(current);
  const candidateRank = ladderRank(candidate);
  return candidateRank > currentRank ? candidate : current;
}
