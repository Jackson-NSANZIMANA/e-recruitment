// ══════════════════════════════════════════════════════════════════
// document-forensics-service — DocumentRecordStore port
//
// Durable home of the verdict: the owning agency's document_records table
// (the columns have existed since the baseline schema — this service is their
// first writer). The application lookup doubles as the cross-agency guard:
// document_records has no RLS (agency = schema), so verifying the application
// exists in the CLAIMED agency's schema before writing is the correctness
// boundary, exactly as in every other system_service adapter.
// ══════════════════════════════════════════════════════════════════

import type { Agency, DocumentType } from '@usrp/shared-types';
import type { ForensicsVerdict } from './forensics-analyzer.js';

export interface RecordVerdictInput {
  readonly applicationId: string;
  readonly agency: Agency;
  readonly documentType: DocumentType;
  readonly objectBucket: string;
  readonly objectKey: string;
  readonly fileSizeBytes: number;
  readonly virusScanStatus: 'CLEAN' | 'INFECTED';
  readonly verdict: ForensicsVerdict;
  /**
   * These bytes REPLACED an earlier upload of this document type (the ingress
   * path, where the citizen re-uploads a corrected file). The row and the
   * object key are deliberately stable, so the record must also stop claiming
   * anything a human decided about the OLD bytes — see the review columns in
   * the adapter. Absent for a RE-ANALYSIS of the same stored object (the
   * analyze/ path), which replaces no content at all.
   */
  readonly objectReplaced?: boolean;
}

export type RecordVerdictOutcome =
  /**
   * Verdict stored — a new document row, a re-analysis of the same object, or a
   * replacement of it. `reviewCleared` reports that a PREVIOUS human decision
   * was withdrawn because the bytes it was made about no longer exist.
   */
  | { readonly kind: 'RECORDED'; readonly documentId: string; readonly reviewCleared?: boolean }
  /** No such application in the claimed agency's schema — cross-agency guard. */
  | { readonly kind: 'APPLICATION_NOT_FOUND' };

export interface DocumentRecordStore {
  recordVerdict(input: RecordVerdictInput): Promise<RecordVerdictOutcome>;
}
