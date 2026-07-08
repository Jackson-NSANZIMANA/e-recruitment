// ══════════════════════════════════════════════════════════════════
// background-vetting-service — Criminal-clearance decision (pure domain)
//
// The heart of the gate. Maps RIB's coarse records flag, together with the
// per-category conviction threshold, onto a CriminalClearanceStatus. Pure and
// total: no I/O, no clock, no throw — same inputs always yield the same
// verdict, so the entire policy is unit-testable in isolation.
//
// The mapping is deliberately FAIL-CLOSED and honest about RIB's information
// limits (RIB returns only a status flag, never a sentence length):
//
//   RIB status            │ threshold                  │ verdict
//   ──────────────────────┼────────────────────────────┼──────────────────────
//   CLEAR                 │ (any)                      │ CLEARED
//   UNDER_INVESTIGATION   │ (any)                      │ UNDER_REVIEW
//   HAS_RECORDS           │ ANY_CONVICTION (RDF, RCS)  │ FLAGGED_CONVICTION
//   HAS_RECORDS           │ IMPRISONMENT_* (RNP)       │ UNDER_REVIEW
//
// Rationale for the two HAS_RECORDS branches:
//   • Agencies whose rule is "ANY conviction disqualifies" (RDF, RCS) need
//     no further detail — the mere existence of records is decisive.
//   • Agencies whose rule is a sentence-length threshold (RNP: >6mo / ≥6mo)
//     CANNOT be auto-decided from a coarse flag: we don't know the sentence.
//     Auto-clearing would be unsafe; auto-rejecting would be unjust. So the
//     honest, fail-closed action is to route to human adjudication
//     (UNDER_REVIEW) — the "separate authorized physical request" RIB
//     documents for detailed records.
//
// FLAGGED_PROSECUTION (RCS "under active prosecution") and FLAGGED_DISMISSED
// (dismissed from public service) are part of the CriminalClearanceStatus
// domain but are NOT reachable from this mock's three-state answer — they
// require a richer RIB response. They are handled the day RIB returns that
// detail; until then the coarse flags conservatively yield the verdicts above.
// ══════════════════════════════════════════════════════════════════

import {
  CRIMINAL_THRESHOLD_BY_CATEGORY,
  type ApplicationCategory,
  type CriminalClearanceStatus,
  type CriminalConvictionThreshold,
  type RIBRecordStatus,
} from '@usrp/shared-types';

export interface CriminalClearanceDecision {
  /** The recorded clearance verdict for the audit + downstream projection. */
  readonly clearanceStatus: CriminalClearanceStatus;
  /** True only when the applicant is auto-cleared with no human step needed. */
  readonly cleared: boolean;
  /** The per-agency/category rule that was applied — recorded for audit. */
  readonly appliedThreshold: CriminalConvictionThreshold;
  /** Human-readable justification, mirrored into the audit metadata. */
  readonly reason: string;
}

/**
 * Evaluate criminal clearance for a chosen category against RIB's coarse
 * records flag. Pure — the caller supplies the RIB status it fetched.
 */
export function evaluateCriminalClearance(
  category: ApplicationCategory,
  ribStatus: RIBRecordStatus,
): CriminalClearanceDecision {
  const appliedThreshold = CRIMINAL_THRESHOLD_BY_CATEGORY[category];

  switch (ribStatus) {
    case 'CLEAR':
      return {
        clearanceStatus: 'CLEARED',
        cleared: true,
        appliedThreshold,
        reason: 'RIB returned no criminal records.',
      };

    case 'UNDER_INVESTIGATION':
      // An active investigation is never auto-cleared for any agency — it is
      // not yet a conviction, but it cannot be waved through either.
      return {
        clearanceStatus: 'UNDER_REVIEW',
        cleared: false,
        appliedThreshold,
        reason: 'RIB reports an active investigation — requires human adjudication.',
      };

    case 'HAS_RECORDS':
      if (appliedThreshold === 'ANY_CONVICTION') {
        // RDF / RCS: any conviction disqualifies — the flag is decisive.
        return {
          clearanceStatus: 'FLAGGED_CONVICTION',
          cleared: false,
          appliedThreshold,
          reason:
            'RIB reports criminal records; this category disqualifies on ANY conviction.',
        };
      }
      // RNP (>6mo / ≥6mo): the coarse flag cannot prove sentence length, so
      // we can neither auto-clear nor auto-reject — route to adjudication.
      return {
        clearanceStatus: 'UNDER_REVIEW',
        cleared: false,
        appliedThreshold,
        reason:
          'RIB reports criminal records; the sentence-length threshold cannot be ' +
          'auto-decided from a coarse flag — requires authorized detailed review.',
      };
  }
}
