import type { DocumentLane } from './eligibility.types';

// ── Document Forensics ────────────────────────────────────────────

export interface ForensicsFlags {
  readonly elaAnomalyDetected: boolean;
  readonly fontMismatchDetected: boolean;
  readonly stampCloneDetected: boolean;
  readonly ganGeneratedDetected: boolean;  // DCT frequency analysis
  readonly c2paManifestValid: boolean | null;
  readonly virusScanClean: boolean;
  readonly metadataStripped: boolean;
  readonly overallScore: number;           // 0-100 (100 = clean)
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
