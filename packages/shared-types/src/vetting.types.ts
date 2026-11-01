import type { DocumentLane } from './eligibility.types';

// ── Document Forensics ────────────────────────────────────────────

/**
 * Per-check forensics signals. `null` = NOT ANALYZED — the check belongs to
 * the deferred perceptual/ML tier (its own future program, own ADR + validation
 * plan) and no verdict may be asserted for it. Only the bounded-real tier
 * (virus scan, metadata parse, C2PA-manifest presence) reports booleans today;
 * `false` on a deferred check would falsely claim "checked and clean".
 */
export interface ForensicsFlags {
  readonly elaAnomalyDetected: boolean | null;      // deferred tier (ELA re-encode)
  readonly fontMismatchDetected: boolean | null;    // deferred tier (OCR)
  readonly stampCloneDetected: boolean | null;      // deferred tier (OCR/CV)
  readonly ganGeneratedDetected: boolean | null;    // deferred tier (DCT frequency analysis)
  readonly c2paManifestValid: boolean | null;       // presence/parse only today; null = no manifest claim
  readonly virusScanClean: boolean;                 // REAL — ClamAV verdict
  readonly metadataStripped: boolean;               // REAL — byte-level metadata parse
  readonly overallScore: number;                    // 0-100 (100 = clean)
}

export interface DocumentForensicsResult {
  readonly documentId: string;
  readonly lane: DocumentLane;
  readonly flags: ForensicsFlags;
  readonly requiresHumanReview: boolean;
  readonly processingTimeMs: number;
  readonly analyzedAt: string;
}

// ── Triage Queue Item (for HR Officer dashboard) ──────────────────

export interface AmberLaneQueueItem {
  readonly processingCode: string;         // "RDF-90823" — no real name
  readonly documentType: string;
  readonly primaryFlag: string;            // e.g. "ELA Anomaly"
  readonly forensicsScore: number;
  readonly queuedAt: string;
}

// ── Criminal-clearance review reasons (ADR-048 §2.3-2.4) ──────────
//
// The closed vocabulary of "why a human must look" at a criminal-clearance
// certificate. It is declared HERE, once, because four artefacts enforce it and
// three of them used to hold their own copy:
//
//   • rls/0044             the `clearance_verif_shape_check` CHECK constraint
//   • background-vetting   what a verdict may carry (the writer)
//   • application-service  `CLEARANCE_QUEUE_REASONS` — what the amber queue may show
//   • edge-gateway         `CLEARANCE_REASONS` — what an officer's checklist may carry
//
// A reason added to the writer but not to a reader is not a cosmetic gap: the
// reader REJECTS the payload, so the officer's checklist answered 502 for the
// whole application and the case disappeared from the queue. One tuple, one set.
export const CLEARANCE_REVIEW_REASONS = [
  /** The certificate's content needs a decision only a human can make. */
  'CLEARANCE_CONTENT_REVIEW',
  /** The name on the certificate is only partly the applicant's. */
  'IDENTITY_NAME_PARTIAL',
  /** The holder field could not be read at all. */
  'IDENTITY_HOLDER_UNREADABLE',
  /**
   * We could not verify it — the registry never answered within the retry
   * budget, so the certificate went to a human unverified instead of sitting at
   * PENDING for ever. Deliberately cause-neutral: the same landing place for an
   * Irembo outage, a network partition or an unreadable registry response.
   */
  'CLEARANCE_UNVERIFIED',
] as const;

export type ClearanceReviewReason = (typeof CLEARANCE_REVIEW_REASONS)[number];

/** Membership test for the readers that rebuild a payload field by field. */
export const CLEARANCE_REVIEW_REASON_SET: ReadonlySet<string> = new Set(CLEARANCE_REVIEW_REASONS);
