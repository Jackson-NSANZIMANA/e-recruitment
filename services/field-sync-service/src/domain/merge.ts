// ══════════════════════════════════════════════════════════════════
// field-sync-service — Hybrid conflict resolution (pure, ADR-010 §3)
//
// physical_test_scores is an append-only log per application: a correction is a
// NEW signed record, never an edit (ADR-003 §4 immutability). The authoritative
// "current" score is the record whose vector clock DOMINATES every other — the
// unique HEAD. When two offline devices score the same applicant without seeing
// each other, there are TWO undominated heads: a genuine conflict.
//
// decideMerge() compares an incoming record's clock against the current head
// set and returns what to do — the whole conflict policy in one pure function:
//   DUPLICATE  — same signed payload already stored → no-op (idempotent replay)
//   ACCEPT     — first record for this application → store as the head
//   SUPERSEDE  — dominates every head → valid correction; append as new head
//                (also RESOLVES a prior conflict if it dominates all heads)
//   STALE      — dominated by / equal to a head → older or already-seen → no-op
//   CONFLICT   — concurrent with some head → keep both, flag, HOLD the app
//
// No official result is ever silently chosen: CONFLICT holds for human
// adjudication (the resolve endpoint), it does not pick a winner.
// ══════════════════════════════════════════════════════════════════

import { compareClocks, type VectorClock } from './vector-clock.js';

/** The minimal view of a stored record the merge decision needs. */
export interface StoredRecordRef {
  readonly vectorClock: VectorClock;
  readonly signedPayloadHash: string;
}

export type MergeDecision =
  /** No record with this payload hash exists yet, and no prior record at all. */
  | { readonly kind: 'ACCEPT' }
  /** This exact signed payload is already stored — idempotent replay/re-upload. */
  | { readonly kind: 'DUPLICATE' }
  /** Incoming dominates every current head — a valid correction (append as head). */
  | { readonly kind: 'SUPERSEDE' }
  /** Incoming is dominated by / equal to a head — older or already reflected. */
  | { readonly kind: 'STALE' }
  /** Incoming is concurrent with a head — genuine conflict; keep both, hold. */
  | { readonly kind: 'CONFLICT' };

/**
 * The undominated records — those not causally preceded by any other. In a
 * clean state there is exactly one head; a conflict leaves two or more mutually
 * concurrent heads. Pure; O(n²) over a tiny per-application record set.
 */
export function computeHeads<T extends StoredRecordRef>(records: readonly T[]): readonly T[] {
  return records.filter(
    (candidate) =>
      !records.some(
        (other) =>
          other !== candidate &&
          compareClocks(other.vectorClock, candidate.vectorClock) === 'DOMINATES',
      ),
  );
}

/**
 * Decide how an incoming record merges into the existing records for one
 * application. Pure — the caller supplies the current record set and performs
 * the resulting write.
 */
export function decideMerge(
  incoming: StoredRecordRef,
  existing: readonly StoredRecordRef[],
): MergeDecision {
  // Idempotent replay: the exact signed payload is already stored. Checked
  // first so a re-uploaded batch is a no-op regardless of clock arithmetic.
  if (existing.some((r) => r.signedPayloadHash === incoming.signedPayloadHash)) {
    return { kind: 'DUPLICATE' };
  }

  const heads = computeHeads(existing);
  if (heads.length === 0) return { kind: 'ACCEPT' };

  const relations = heads.map((h) => compareClocks(incoming.vectorClock, h.vectorClock));

  // Concurrent with ANY head ⇒ conflict (even if it also dominates another head:
  // it cannot become the sole authoritative record while a peer is unresolved).
  if (relations.includes('CONCURRENT')) return { kind: 'CONFLICT' };

  // Dominated by / equal to a head ⇒ the head already reflects this causally.
  if (relations.some((r) => r === 'DOMINATED' || r === 'EQUAL')) return { kind: 'STALE' };

  // Strictly dominates every head ⇒ the new authoritative record.
  return { kind: 'SUPERSEDE' };
}
