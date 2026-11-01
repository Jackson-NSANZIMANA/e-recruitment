// ══════════════════════════════════════════════════════════════════
// @usrp/shared-types — The vetting-hold officer verb's closed vocabulary (D10)
//
// THE DEFECT THIS CLOSES (evaluation 2026-10-29, D10). The review queue
// (`listAmberQueue`) shows an application held on a criminal-clearance
// UNDER_REVIEW or on a NESA review — and NOTHING could act on either. The
// amber lane had a verb (adjudicate); the vetting-hold lane had only a listing.
// An officer could see the work and not do it.
//
// THE SHAPE OF THE VERB. A hold is always a single vetting dimension on a single
// application, with a decision, a REASON, and an optional note:
//
//   POST /v1/applications/vetting-hold
//   { applicationId, dimension, decision, reasonCode, notes? }
//
// THE REASON IS THE VERDICT. Two independent fields (decision + a free-text
// reason) would let the trail say "REJECT, CLEARANCE_CONFIRMED" — a record that
// contradicts itself and cannot be replayed. So the closed reason set below is
// the whole truth: each reason names ONE dimension, ONE decision, and the exact
// evidence value it writes. The officer picks a reason; `decision` is a check
// against it (a mismatch is a caller error, not a silent coercion) and the
// repository writes `evidence` — never a value inferred from prose.
//
// WHY THE EVIDENCE VALUE IS REUSED, not invented: the row's vetting columns are
// the pure lifecycle's input (`deriveApplicationStatus`). Resolving a hold means
// answering the gate truthfully and letting the SAME function that placed every
// other status compute the next one, so a resolved criminal hold rejoins the
// green lane exactly like an autonomously cleared one.
// ══════════════════════════════════════════════════════════════════

import type { AcademicEligibilityStatus, CriminalClearanceStatus } from './eligibility.types.js';

/** The vetting dimensions that can hold an application for a human. */
export const VETTING_HOLD_DIMENSIONS = ['CRIMINAL', 'ACADEMIC'] as const;
export type VettingHoldDimension = (typeof VETTING_HOLD_DIMENSIONS)[number];

export type VettingHoldDecision = 'CLEAR' | 'REJECT';

/**
 * WHAT THE QUEUE TELLS THE CONSOLE TO DO (D10, the other half of the defect).
 *
 * `listAmberQueue` returned `status` + `reasons`, and the console had to INFER
 * from them which verb applied. That inference is exactly how a screen ends up
 * offering "Adjudicate" on an application held on a criminal-clearance review —
 * a button that answers 409. Each queue row now names the verbs that apply, as a
 * closed set: a row can genuinely need both (an amber document hold ON an
 * application whose clearance is also under review), so this is a set, not a
 * single value.
 */
export const AMBER_QUEUE_ACTIONS = ['ADJUDICATE', 'RESOLVE_VETTING_HOLD'] as const;
export type AmberQueueAction = (typeof AMBER_QUEUE_ACTIONS)[number];

/** Every reason clears or rejects exactly one dimension. */
export interface VettingHoldReasonSpec {
  readonly dimension: VettingHoldDimension;
  readonly decision: VettingHoldDecision;
  /** What the officer asserted, in one clause — carried onto the audit trail. */
  readonly assertion: string;
  /** The vetting-column value this reason WRITES. Never inferred, never free text. */
  readonly criminalStatus?: CriminalClearanceStatus;
  readonly academicStatus?: AcademicEligibilityStatus;
}

/**
 * The one table. A reason that is absent from it is not sayable, and a verdict
 * the officer did not pick a reason for cannot be written.
 */
export const VETTING_HOLD_REASONS = {
  // ── CRIMINAL: cleared ───────────────────────────────────────────
  CLEARANCE_CONFIRMED: {
    dimension: 'CRIMINAL',
    decision: 'CLEAR',
    assertion: 'the criminal record was obtained and shows no disqualifying entry',
    criminalStatus: 'CLEARED',
  },
  CLEARANCE_IDENTITY_RESOLVED: {
    dimension: 'CRIMINAL',
    decision: 'CLEAR',
    assertion: 'the partial name on the clearance certificate was resolved to this applicant',
    criminalStatus: 'CLEARED',
  },
  // ── CRIMINAL: rejected (the three hard-fail verdicts) ───────────
  CONVICTION_CONFIRMED: {
    dimension: 'CRIMINAL',
    decision: 'REJECT',
    assertion: 'a disqualifying conviction was confirmed',
    criminalStatus: 'FLAGGED_CONVICTION',
  },
  PROSECUTION_CONFIRMED: {
    dimension: 'CRIMINAL',
    decision: 'REJECT',
    assertion: 'an active prosecution was confirmed',
    criminalStatus: 'FLAGGED_PROSECUTION',
  },
  PUBLIC_SERVICE_DISMISSAL_CONFIRMED: {
    dimension: 'CRIMINAL',
    decision: 'REJECT',
    assertion: 'a dismissal from public service was confirmed',
    criminalStatus: 'FLAGGED_DISMISSED',
  },
  // ── ACADEMIC (NESA review): cleared ─────────────────────────────
  NESA_RECORD_CONFIRMED: {
    dimension: 'ACADEMIC',
    decision: 'CLEAR',
    assertion: 'NESA confirmed the record behind this qualification',
    academicStatus: 'ELIGIBLE',
  },
  NESA_DOCUMENT_VERIFIED: {
    dimension: 'ACADEMIC',
    decision: 'CLEAR',
    assertion: 'the qualification was verified against the document the applicant supplied',
    academicStatus: 'ELIGIBLE',
  },
  // ── ACADEMIC (NESA review): rejected ────────────────────────────
  QUALIFICATION_NOT_RECOGNISED: {
    dimension: 'ACADEMIC',
    decision: 'REJECT',
    assertion: 'the qualification is not recognised for this category',
    academicStatus: 'INELIGIBLE',
  },
  ACADEMIC_REQUIREMENT_NOT_MET: {
    dimension: 'ACADEMIC',
    decision: 'REJECT',
    assertion: 'the verified record does not meet the category requirement',
    academicStatus: 'INELIGIBLE',
  },
} as const satisfies Readonly<Record<string, VettingHoldReasonSpec>>;

export type VettingHoldReason = keyof typeof VETTING_HOLD_REASONS;

/** Runtime membership test for the ingress boundary (body → reason). */
export function isVettingHoldReason(value: unknown): value is VettingHoldReason {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(VETTING_HOLD_REASONS, value);
}

/** Runtime membership test for `dimension`. */
export function isVettingHoldDimension(value: unknown): value is VettingHoldDimension {
  return typeof value === 'string' && (VETTING_HOLD_DIMENSIONS as readonly string[]).includes(value);
}

/** Runtime membership test for `decision`. */
export function isVettingHoldDecision(value: unknown): value is VettingHoldDecision {
  return value === 'CLEAR' || value === 'REJECT';
}
