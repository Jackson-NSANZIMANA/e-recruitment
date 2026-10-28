// ══════════════════════════════════════════════════════════════════
// eligibility-service — NESA domain model (SDMS results, ADR-047/048)
//
// The domain's shape for an A-Level results lookup, decoupled from SDMS's
// wire format. It now carries the HOLDER fields (name, sex, NID hint): a
// result is evidence only once it is bound to the applicant (ADR-048 §2.2).
// Every result carries the `nesaRequestId` for cross-system tracing.
// ══════════════════════════════════════════════════════════════════

import type { QualificationLevel } from '@usrp/shared-types';

export interface NesaHolder {
  /** "SURNAME Forename" as printed. Transient: used for binding, never stored. */
  readonly name: string;
  readonly sex: 'MALE' | 'FEMALE' | null;
  /** Masked NID "NNNN********NNNN", or null when the registry gives none. */
  readonly nationalIdHint: string | null;
}

export interface NesaSubjectMark {
  readonly subjectName: string;
  readonly markPercent: number;
  readonly letterGrade: string;
  readonly numberOfPeriods: number;
}

export interface NesaResults {
  readonly indexNumber: string;
  readonly holder: NesaHolder;
  /** false = results not yet out: PENDING, retried, never ineligible. */
  readonly published: boolean;
  /** true = REVIEW by a human, never automatic. */
  readonly malpractice: boolean;
  /** The registry's combinationLevelType, verbatim (e.g. TVET). */
  readonly levelType: string;
  /** The ladder level it maps to; null = an unrecognised level type (REVIEW). */
  readonly qualificationLevel: QualificationLevel | null;
  readonly division: string;
  readonly weightedPercent: number | null;
  readonly resultsAggregate: number | null;
  readonly examYear: number | null;
  readonly combination: string;
  readonly subjects: readonly NesaSubjectMark[];
}

/**
 * Outcome of a NESA lookup by examination index number. NOT_FOUND is a
 * business outcome (no candidate for that index), not an infrastructure fault.
 */
export type NesaLookupResult =
  | { readonly status: 'FOUND'; readonly nesaRequestId: string; readonly results: NesaResults }
  | { readonly status: 'NOT_FOUND'; readonly nesaRequestId: string };

/**
 * NESA could not be reached, timed out, rate-limited us, or answered a
 * non-2xx / malformed / truncated body (or, in production, a sandbox answer).
 * An infrastructure fault, never a statement about the candidate.
 */
export class NesaUnavailableError extends Error {
  constructor(
    message: string,
    readonly nesaRequestId: string,
  ) {
    super(message);
    this.name = 'NesaUnavailableError';
  }
}
