// ══════════════════════════════════════════════════════════════════
// document-forensics-service — Supersession decision (pure, D8)
//
// THE DEFECT THIS ENCODES (evaluation 2026-10-29, D8). A second upload of the
// same document type silently UPDATE'd the slot: same documentId, no revision,
// and `human_reviewed_*` untouched. A citizen could get a certificate reviewed
// CLEAR and then replace the bytes under the platform's own approval stamp.
//
// THE RULE (ADR-052 §3.3), and it is deliberately one function:
//
//   a replacement upload is accepted while BOTH hold
//     • the case has not moved past document review, and
//     • the slot has no human review stamp;
//   identical bytes are a RETRY, not a revision.
//
// WHY PURE. The same decision runs inside a FOR UPDATE transaction, where it is
// hard to test and impossible to test exhaustively. Keeping the predicate here
// means the store CANNOT drift from it (it has no branch of its own), and every
// combination is provable without a database: status × stamp × digest.
//
// The rank comes from the CANONICAL APPLICATION_STATUSES order, the same one
// the lifecycle uses. A hand-written status list here is how the two would
// disagree the first time somebody inserts a status.
// ══════════════════════════════════════════════════════════════════

import { APPLICATION_STATUSES, type ApplicationStatus } from '@usrp/shared-types';

/**
 * The last status at which a document slot is still the citizen's to change.
 * DOCUMENT_REVIEW_AMBER is the routine document-review hold — its documents are
 * by definition not yet decided. Anything ranked above it has been cleared past
 * review or moved on to scheduling, and by then the file is part of a case in
 * progress.
 */
export const LAST_REPLACEABLE_STATUS: ApplicationStatus = 'DOCUMENT_REVIEW_AMBER';
const LAST_REPLACEABLE_RANK = APPLICATION_STATUSES.indexOf(LAST_REPLACEABLE_STATUS);

/** The slot as the store reads it under FOR UPDATE. */
export interface SlotState {
  readonly caseStatus: ApplicationStatus;
  /** `document_records.human_reviewed_at !== null` — an officer decided. */
  readonly humanReviewed: boolean;
  /** The slot's stored digest, or null for a row predating rls/0044. */
  readonly storedHmac: string | null;
  /** True when a row already exists for this (application, object key). */
  readonly exists: boolean;
}

export type SupersessionDecision =
  /** First upload into this slot: create the row, revision 1, write the object. */
  | { readonly kind: 'CREATE' }
  /** Different bytes, unreviewed, case still in document review: revision n+1. */
  | { readonly kind: 'SUPERSEDE'; readonly revision: number }
  /** Identical bytes: a retry. No new revision, no object write. */
  | { readonly kind: 'RETRY'; readonly revision: number }
  /** An officer decided these bytes. Refused — needs an officer-initiated re-open. */
  | { readonly kind: 'CLOSED_HUMAN_REVIEW' }
  /** The case has moved past document review. Refused. */
  | { readonly kind: 'CLOSED_CASE_ADVANCED' };

/**
 * Decide what an upload means for a slot. Total over its inputs.
 *
 * ORDER OF PRECEDENCE, and each step is a decision:
 *   1. No row      → CREATE (a case-advancement check still applies: a citizen
 *                    cannot add a document to a case already past review).
 *   2. Stamped     → CLOSED_HUMAN_REVIEW. Checked BEFORE the case-advancement
 *                    rule because it is the stronger fact: an officer judged
 *                    THESE bytes, and that survives any later status change.
 *   3. Advanced    → CLOSED_CASE_ADVANCED.
 *   4. Same digest → RETRY (a flaky network must not inflate a revision count
 *                    into something a reviewer reads as "replaced three times").
 *   5. Otherwise   → SUPERSEDE.
 */
export function decideSupersession(slot: SlotState, incomingHmac: string, currentRevision: number): SupersessionDecision {
  const advanced = APPLICATION_STATUSES.indexOf(slot.caseStatus) > LAST_REPLACEABLE_RANK;

  if (!slot.exists) {
    return advanced ? { kind: 'CLOSED_CASE_ADVANCED' } : { kind: 'CREATE' };
  }
  if (slot.humanReviewed) {
    return { kind: 'CLOSED_HUMAN_REVIEW' };
  }
  if (advanced) {
    return { kind: 'CLOSED_CASE_ADVANCED' };
  }
  if (slot.storedHmac !== null && slot.storedHmac === incomingHmac) {
    return { kind: 'RETRY', revision: currentRevision };
  }
  return { kind: 'SUPERSEDE', revision: currentRevision + 1 };
}

/** True when the decision means "nothing was written and the object was not touched". */
export function isRefusal(decision: SupersessionDecision): decision is Extract<
  SupersessionDecision,
  { kind: 'CLOSED_HUMAN_REVIEW' | 'CLOSED_CASE_ADVANCED' }
> {
  return decision.kind === 'CLOSED_HUMAN_REVIEW' || decision.kind === 'CLOSED_CASE_ADVANCED';
}
