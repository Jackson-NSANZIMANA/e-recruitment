// ══════════════════════════════════════════════════════════════════
// document-forensics-service — DocumentRecordStore port
//
// Durable home of the verdict: the owning agency's document_records table (the
// columns have existed since the baseline schema — this service is their first
// writer). The application lookup doubles as the cross-agency guard:
// document_records has no RLS (agency = schema), so verifying the application
// exists in the CLAIMED agency's schema before writing is the correctness
// boundary, exactly as in every other system_service adapter.
//
// ── D8 (ADR-052): THE STORE OWNS THE REVIEW LOCK, SO IT OWNS THE OBJECT WRITE ──
//
// A reviewed document must not be replaceable. The old sequence was
// putObject → recordVerdict, which means a refusal decided inside the record
// transaction arrives AFTER the bytes have already overwritten the object the
// officer approved: the row keeps the stamp, the file is gone. So the object
// write is handed to the store as `writeObject` and invoked INSIDE the slot-lock
// transaction, after the lock has been granted and the gate has passed. If the
// gate refuses, the callback is never called and the bytes at rest are
// untouched — the refusal is real, not cosmetic.
//
// The callback runs while the slot row is locked. That is the price of not
// destroying evidence, and it is bounded by one object PUT.
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
  readonly mimeType: string;
  readonly virusScanStatus: 'CLEAN' | 'INFECTED';
  /**
   * D8: KEYED digest of the bytes (HMAC). Identical bytes re-uploaded are ONE
   * revision, not two — the store compares this with the slot's stored digest.
   */
  readonly contentHmac: string;
  readonly verdict: ForensicsVerdict;
  /**
   * D8: put the bytes at `objectBucket`/`objectKey`. Called INSIDE the slot
   * lock, only once the review gate has passed. Never called on a refusal.
   */
  readonly writeObject: () => Promise<void>;
}

export type RecordVerdictOutcome =
  /**
   * Verdict stored. `revision` is the slot's revision AFTER this upload — 1 for
   * the first upload, n+1 for a supersession, and unchanged for a retry of
   * identical bytes (`superseded: false`).
   */
  | {
      readonly kind: 'RECORDED';
      readonly documentId: string;
      readonly revision: number;
      /** True only when this upload REPLACED different bytes. */
      readonly superseded: boolean;
    }
  /**
   * D8: the slot is under human review (or the case has moved past document
   * review). Nothing was written and the object was NOT touched — a reviewed
   * document is evidence, and changing it needs an officer-initiated re-open.
   */
  | { readonly kind: 'REVIEW_CLOSED'; readonly reason: 'HUMAN_REVIEWED' | 'CASE_ADVANCED' }
  /** No such application in the claimed agency's schema — cross-agency guard. */
  | { readonly kind: 'APPLICATION_NOT_FOUND' };

export interface DocumentRecordStore {
  recordVerdict(input: RecordVerdictInput): Promise<RecordVerdictOutcome>;
}
