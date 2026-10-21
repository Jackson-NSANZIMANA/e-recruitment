// ══════════════════════════════════════════════════════════════════
// biometric-service — Threshold policies and outcome rules (pure, ADR-037 §6)
//
// A device declares the outcome it computed AND the policy version it used.
// The server recomputes the outcome from the integer scores under that same
// registered version and refuses a record whose declaration differs. Scores
// are basis points (0..10000) so the rule is exact on every platform.
//
// A failed liveness is INCONCLUSIVE, never NO_MATCH: "we could not tell that
// a live person was there" is not evidence that it is someone else. Neither
// outcome refuses anybody (ADR-037 §1) — both route to supervised manual
// identity.
//
// PURE and TOTAL.
// ══════════════════════════════════════════════════════════════════

export const EVIDENCE_OUTCOMES = ['MATCH', 'NO_MATCH', 'INCONCLUSIVE', 'NOT_ATTEMPTED'] as const;
export type EvidenceOutcome = (typeof EVIDENCE_OUTCOMES)[number];

/** Outcomes that require supervised manual identity before admission. */
export const MANUAL_IDENTITY_OUTCOMES: ReadonlySet<EvidenceOutcome> = new Set<EvidenceOutcome>([
  'NO_MATCH',
  'INCONCLUSIVE',
]);

export interface ThresholdPolicy {
  readonly version: string;
  /** Liveness at or above this passes; below is INCONCLUSIVE. */
  readonly livenessPassBp: number;
  /** Match at or above this is MATCH (given liveness passed). */
  readonly matchBp: number;
  /** Match strictly below this is NO_MATCH (given liveness passed). */
  readonly noMatchBelowBp: number;
}

export const BASIS_POINTS_MAX = 10_000;

/**
 * The registry. Values are ENGINEERING PLACEHOLDERS until B3 measures the
 * on-device model on the SHADOW pilot (ADR-044 adds the next version).
 * A version is never edited once used: add a new one.
 */
export const THRESHOLD_POLICIES: Readonly<Record<string, ThresholdPolicy>> = Object.freeze({
  'BIO-THRESHOLDS.v1': Object.freeze({
    version: 'BIO-THRESHOLDS.v1',
    livenessPassBp: 8_500,
    matchBp: 8_500,
    noMatchBelowBp: 6_000,
  }),
});

export const DEFAULT_THRESHOLD_POLICY_VERSION = 'BIO-THRESHOLDS.v1';

export function thresholdPolicy(version: string): ThresholdPolicy | null {
  return Object.prototype.hasOwnProperty.call(THRESHOLD_POLICIES, version)
    ? (THRESHOLD_POLICIES[version] ?? null)
    : null;
}

function isBasisPoints(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= BASIS_POINTS_MAX;
}

/**
 * The outcome of an ATTEMPTED capture under a policy. Throws only on scores
 * outside 0..10000 integers (bad input — the record parser rejects those
 * first).
 */
export function attemptedOutcome(
  livenessScoreBp: number,
  matchScoreBp: number,
  policy: ThresholdPolicy,
): Exclude<EvidenceOutcome, 'NOT_ATTEMPTED'> {
  if (!isBasisPoints(livenessScoreBp) || !isBasisPoints(matchScoreBp)) {
    throw new RangeError('scores must be integer basis points 0..10000');
  }
  if (livenessScoreBp < policy.livenessPassBp) return 'INCONCLUSIVE';
  if (matchScoreBp >= policy.matchBp) return 'MATCH';
  if (matchScoreBp < policy.noMatchBelowBp) return 'NO_MATCH';
  return 'INCONCLUSIVE';
}
