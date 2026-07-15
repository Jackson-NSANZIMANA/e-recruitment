// ══════════════════════════════════════════════════════════════════
// document-forensics-service — ForensicsAnalyzer port
//
// THE seam the forensics programme grows behind (ADR-011). Today's adapter is
// the bounded-real tier: virus scan + container/metadata parse + C2PA-manifest
// presence — real signals from real bytes, all provable with zero new runtime
// dependencies (invariant #5 intact). The heavy perceptual tier (ELA, anti-GAN
// DCT, OCR font/stamp-clone) is a DEFERRED programme with its own ADR and
// validation plan (labeled forgery corpus, FP/FN targets); when it lands it
// implements THIS port and the rest of the lane is untouched. Checks the
// current tier cannot perform are reported as null ("not analyzed"), never
// false ("checked and clean") — the contract keeps us honest.
// ══════════════════════════════════════════════════════════════════

import type { DocumentLane, ForensicsFlags } from '@usrp/shared-types';

/** The analyzer's verdict on one document's bytes. */
export interface ForensicsVerdict {
  readonly lane: DocumentLane;
  readonly score: number;        // 0-100 (100 = clean)
  readonly flags: ForensicsFlags;
}

export type AnalyzeResult =
  | { readonly kind: 'ANALYZED'; readonly verdict: ForensicsVerdict }
  | { readonly kind: 'SCANNER_UNAVAILABLE'; readonly detail: string };

export interface ForensicsAnalyzer {
  /** Analyze real document bytes. Fail-closed: no scan → no verdict. */
  analyze(bytes: Buffer): Promise<AnalyzeResult>;
}
