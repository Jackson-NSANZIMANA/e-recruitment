// ══════════════════════════════════════════════════════════════════
// field-sync-service — Vector clocks (pure, zero-dep CRDT causality)
//
// A vector clock is a per-device counter map: { "<deviceId>": <count> }. It
// captures causal history without a wall clock, so two tablets scoring the same
// applicant OFFLINE can be compared after they sync — deciding which record is
// newer, which is stale, and which pair is genuinely concurrent (a conflict).
// This is the zero-dependency register the platform chose over Automerge
// (ADR-010 §1): plain maths on plain records, no library.
//
// compareClocks(a, b) answers "where does a sit relative to b?":
//   DOMINATES  — a is causally AFTER b   (a ≥ b on every axis, > on some)
//   DOMINATED  — a is causally BEFORE b  (a ≤ b on every axis, < on some)
//   EQUAL      — identical causal position
//   CONCURRENT — neither precedes the other (each has an axis the other lacks)
// A missing device key counts as 0 (that device had not yet contributed).
// ══════════════════════════════════════════════════════════════════

export type VectorClock = Readonly<Record<string, number>>;

export type ClockRelation = 'DOMINATES' | 'DOMINATED' | 'EQUAL' | 'CONCURRENT';

/** Compare vector clock `a` relative to `b`. Pure; missing axis ⇒ 0. */
export function compareClocks(a: VectorClock, b: VectorClock): ClockRelation {
  let aGreaterSomewhere = false;
  let bGreaterSomewhere = false;

  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    if (av > bv) aGreaterSomewhere = true;
    else if (av < bv) bGreaterSomewhere = true;
  }

  if (aGreaterSomewhere && bGreaterSomewhere) return 'CONCURRENT';
  if (aGreaterSomewhere) return 'DOMINATES';
  if (bGreaterSomewhere) return 'DOMINATED';
  return 'EQUAL';
}

/**
 * Pointwise maximum of two clocks — the least clock that dominates both. Used
 * to advance a device's own clock past everything it has seen before it signs a
 * correcting record, so the correction cleanly DOMINATES what it supersedes.
 */
export function mergeVectorClock(a: VectorClock, b: VectorClock): VectorClock {
  const merged: Record<string, number> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    merged[key] = Math.max(a[key] ?? 0, b[key] ?? 0);
  }
  return merged;
}
