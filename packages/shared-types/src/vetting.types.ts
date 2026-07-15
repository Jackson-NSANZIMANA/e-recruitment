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
