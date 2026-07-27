// ══════════════════════════════════════════════════════════════════
// identity-service — ErasureRequestRepository port (ADR-020, owner D10)
//
// The DPO-intake half of citizen-initiated erasure: the citizen FILES a
// request; an officer/DPO decides it — executes through the existing
// gated erasure road (ADR-015) or declines with a recorded ground. The
// store is PII-free (opaque UUIDs, status, timestamps, a bounded note)
// and its rows survive the erasure they ask for.
// ══════════════════════════════════════════════════════════════════

export interface ErasureRequestRecord {
  readonly requestId: string;
  readonly applicantId: string;
  readonly status: 'PENDING' | 'EXECUTED' | 'DECLINED';
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
}

export type FileRequestOutcome =
  | { readonly kind: 'FILED'; readonly requestId: string }
  /** A live request already exists — re-filing is idempotent, not an error. */
  | { readonly kind: 'ALREADY_PENDING'; readonly requestId: string };

export type DeclineRequestOutcome =
  | {
      readonly kind: 'DECLINED';
      readonly applicantId: string;
      /**
       * The citizen's stored phone, decrypted in the decline transaction
       * (ADR-022) so the decision notice can be sent. MEMORY-ONLY — never
       * logged, persisted, or evented. Null when nothing is on file or the
       * adapter was built without the decryption key.
       */
      readonly noticeContact: string | null;
    }
  /** Already decided — nothing written; the earlier decision stands. */
  | { readonly kind: 'NOT_PENDING'; readonly status: 'EXECUTED' | 'DECLINED' }
  | { readonly kind: 'NOT_FOUND' };

export interface DeclineRequestInput {
  readonly requestId: string;
  readonly officerId: string;
  readonly note: string;
}

export interface ErasureRequestRepository {
  /** File a PENDING request for the applicant (idempotent on a live one). */
  fileRequest(applicantId: string): Promise<FileRequestOutcome>;
  /** The applicant's newest request, whatever its status — the citizen's own view. */
  latestForApplicant(applicantId: string): Promise<ErasureRequestRecord | null>;
  /** The DPO queue: every PENDING request, oldest first. */
  listPending(): Promise<readonly ErasureRequestRecord[]>;
  /** Decline a PENDING request with an accountable ground. */
  decline(input: DeclineRequestInput): Promise<DeclineRequestOutcome>;
  /**
   * Stamp the applicant's PENDING request(s) EXECUTED — called when the
   * gated erasure road actually erased (or found already erased). Returns
   * how many rows were stamped; zero is normal (officer-initiated erasure
   * without a citizen request).
   */
  markExecuted(applicantId: string, officerId: string): Promise<number>;
}
