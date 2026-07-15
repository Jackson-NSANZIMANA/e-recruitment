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
}

export type RecordVerdictOutcome =
  /** Verdict stored (new document row, or re-analysis of the same object). */
  | { readonly kind: 'RECORDED'; readonly documentId: string }
  /** No such application in the claimed agency's schema — cross-agency guard. */
  | { readonly kind: 'APPLICATION_NOT_FOUND' };

export interface DocumentRecordStore {
  recordVerdict(input: RecordVerdictInput): Promise<RecordVerdictOutcome>;
}
