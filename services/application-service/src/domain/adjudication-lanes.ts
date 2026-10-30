// ══════════════════════════════════════════════════════════════════
// application-service — WHICH HOLD a queue row is in (pure domain)
//
// THE DEFECT THIS CLOSES (evaluation D10). The officer queue has shown three
// kinds of hold since S12b: a document hold (`DOCUMENT_REVIEW_AMBER` /
// `ADJUDICATION_REVIEW`), a criminal clearance a human must look at
// (`criminal_clearance_status = 'UNDER_REVIEW'`), and a NESA review
// (`academic_status = 'PENDING'` + `failureCode = 'NESA_REVIEW_REQUIRED'`).
// Only the first could be acted on: `adjudicate` accepted those two statuses
// and answered `NOT_APPLICABLE` for everything else, so an officer could see a
// criminal row, press the only button on the screen, and be refused. Two of the
// three rows in the queue were dead ends.
//
// The operation now names its lane, and the queue row names the lane back, so
// the screen never offers a button that refuses. Both sides read THIS
// predicate: a second copy of these three conditions is how a queue starts
// showing rows an operation cannot touch.
// ══════════════════════════════════════════════════════════════════

import type { ApplicationStatus } from '@usrp/shared-types';

/**
 * A hold an officer can decide. The value is what the client sends back in
 * `lane`, so it is part of the wire contract: never rename one.
 *   • DOCUMENT — a flagged document (or a late-disqualification flag) is waiting
 *     for a human; CLEAR lifts the hold and re-derives the status.
 *   • CRIMINAL — the registry (or the RIB-by-hash path) answered with something
 *     a human must judge; CLEAR records the criminal gate as CLEARED.
 *   • ACADEMIC — NESA could not settle the applicant's education; CLEAR records
 *     the academic gate as ELIGIBLE.
 */
export type AdjudicationLane = 'DOCUMENT' | 'CRIMINAL' | 'ACADEMIC';

/** The code eligibility-service writes when NESA hands a case to a human. */
export const NESA_REVIEW_REQUIRED_CODE = 'NESA_REVIEW_REQUIRED';

/**
 * Statuses the queue treats as settled. A terminal row is never a hold, whatever
 * its dimension columns still say — a rejection does not become undecided.
 */
const TERMINAL: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  'REJECTED',
  'WITHDRAWN',
  'ACCEPTED',
  'WALK_IN_REJECTED',
]);

/** Top-level statuses that ARE a document/adjudication hold. */
const DOCUMENT_HOLD: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  'DOCUMENT_REVIEW_AMBER',
  'ADJUDICATION_REVIEW',
]);

/**
 * The row facts both the queue and the adjudicate guard read. The two dimension
 * verdicts are plain strings because the two readers see them differently — the
 * officer queue casts them to text in SQL, the write path reads the enum — and a
 * predicate that only ever compares them to literals does not need either type.
 */
export interface HoldEvidence {
  readonly status: ApplicationStatus;
  readonly criminalStatus: string;
  readonly academicStatus: string;
  /** `academic_eligibility_detail` jsonb — only `failureCode` is read. */
  readonly academicDetail: Record<string, unknown> | null;
}

/**
 * The lanes this row is currently held in, in a stable order.
 *
 * Order is DOCUMENT, CRIMINAL, ACADEMIC — the order the holds are discovered, so
 * a client that shows them shows the same list every time. Empty means "nothing
 * here needs a human", which is what makes `NOT_APPLICABLE` honest.
 */
export function adjudicationLanes(row: HoldEvidence): readonly AdjudicationLane[] {
  if (TERMINAL.has(row.status)) return [];
  const lanes: AdjudicationLane[] = [];
  if (DOCUMENT_HOLD.has(row.status)) lanes.push('DOCUMENT');
  if (row.criminalStatus === 'UNDER_REVIEW') lanes.push('CRIMINAL');
  if (
    row.academicStatus === 'PENDING' &&
    row.academicDetail !== null &&
    row.academicDetail['failureCode'] === NESA_REVIEW_REQUIRED_CODE
  ) {
    lanes.push('ACADEMIC');
  }
  return lanes;
}
