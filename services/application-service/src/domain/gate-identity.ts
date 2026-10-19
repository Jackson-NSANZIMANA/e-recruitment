// ══════════════════════════════════════════════════════════════════
// application-service — Gate identity from biometric evidence (pure, ADR-037 §1, §9)
//
// Biometric evidence never refuses a candidate. It decides only WHICH identity
// method an admission records, and whether supervised manual identity must
// happen first:
//
//   any NO_MATCH / INCONCLUSIVE evidence without a confirmation by an officer
//   other than the admitting one        → MANUAL_IDENTITY_REQUIRED (check 10)
//   otherwise, a confirmed negative      → NATIONAL_ID_CARD+SUPERVISOR
//   otherwise, a MATCH                   → NATIONAL_ID_CARD+CARD_PORTRAIT
//   otherwise (none, NOT_ATTEMPTED)      → NATIONAL_ID_CARD (without prejudice)
//
// The input is ONLY what the admitting officer's agency role can see, so
// SHADOW evidence (invisible under rls/0034) can never influence this. A later
// NOT_ATTEMPTED or MATCH does not clear an unconfirmed negative.
//
// PURE and TOTAL.
// ══════════════════════════════════════════════════════════════════

export const IDENTITY_METHODS = [
  'NATIONAL_ID_CARD',
  'NATIONAL_ID_CARD+CARD_PORTRAIT',
  'NATIONAL_ID_CARD+SUPERVISOR',
] as const;
export type IdentityMethod = (typeof IDENTITY_METHODS)[number];

export const EVIDENCE_OUTCOMES = ['MATCH', 'NO_MATCH', 'INCONCLUSIVE', 'NOT_ATTEMPTED'] as const;
export type EvidenceOutcome = (typeof EVIDENCE_OUTCOMES)[number];

/** Closed reason codes for a supervisor's confirmation (mirrors rls/0034). */
export const MANUAL_IDENTITY_REASONS = [
  'CARD_PHOTO_OUTDATED',
  'APPEARANCE_CHANGED',
  'POOR_CAPTURE_CONDITIONS',
  'CARD_PORTRAIT_DAMAGED',
  'SECONDARY_DOCUMENT_CHECKED',
  'SUPERVISOR_INTERVIEW',
] as const;
export type ManualIdentityReason = (typeof MANUAL_IDENTITY_REASONS)[number];

export function isManualIdentityReason(value: unknown): value is ManualIdentityReason {
  return typeof value === 'string' && (MANUAL_IDENTITY_REASONS as readonly string[]).includes(value);
}

export function requiresManualIdentity(outcome: EvidenceOutcome): boolean {
  return outcome === 'NO_MATCH' || outcome === 'INCONCLUSIVE';
}

export interface VisibleEvidence {
  readonly evidenceId: string;
  readonly outcome: EvidenceOutcome;
  /** The confirmation of this evidence, if any. */
  readonly confirmation: { readonly confirmationId: string; readonly confirmedById: string } | null;
}

export type GateIdentityDecision =
  | { readonly kind: 'MANUAL_IDENTITY_REQUIRED'; readonly evidenceIds: readonly string[] }
  | {
      readonly kind: 'IDENTIFIED';
      readonly identityMethod: IdentityMethod;
      readonly evidenceIds: readonly string[];
      readonly confirmationIds: readonly string[];
    };

/** PURE, TOTAL. `evidence` = this application's visible evidence for this ticket. */
export function resolveGateIdentity(
  evidence: readonly VisibleEvidence[],
  admittingOfficerId: string,
): GateIdentityDecision {
  const negatives = evidence.filter((e) => requiresManualIdentity(e.outcome));
  const unresolved = negatives.filter(
    (e) => e.confirmation === null || e.confirmation.confirmedById === admittingOfficerId,
  );
  if (unresolved.length > 0) {
    return { kind: 'MANUAL_IDENTITY_REQUIRED', evidenceIds: unresolved.map((e) => e.evidenceId) };
  }
  const evidenceIds = evidence.map((e) => e.evidenceId);
  if (negatives.length > 0) {
    return {
      kind: 'IDENTIFIED',
      identityMethod: 'NATIONAL_ID_CARD+SUPERVISOR',
      evidenceIds,
      confirmationIds: negatives.flatMap((e) => (e.confirmation === null ? [] : [e.confirmation.confirmationId])),
    };
  }
  if (evidence.some((e) => e.outcome === 'MATCH')) {
    return { kind: 'IDENTIFIED', identityMethod: 'NATIONAL_ID_CARD+CARD_PORTRAIT', evidenceIds, confirmationIds: [] };
  }
  return { kind: 'IDENTIFIED', identityMethod: 'NATIONAL_ID_CARD', evidenceIds, confirmationIds: [] };
}
