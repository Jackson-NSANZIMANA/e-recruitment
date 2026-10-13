// ══════════════════════════════════════════════════════════════════
// application-service — SubmissionLedger port (ADR-027)
//
// THE FRONT DOOR'S DECISION OF RECORD. The same shape scheduling-service's
// SlotLedger has (ADR-026), for the same reason: the thing that must not
// happen twice is recorded in the SAME transaction as the thing it guards.
//
// `recordSubmission` is ONE atomic unit:
//
//   public_core.submission_requests   (the idempotency record)
//   <agency>_ops.applications         (the application)
//   <agency>_ops.application_status_history (its opening null→SUBMITTED row)
//   public_core.event_outbox          (APPLICANT_SUBMITTED)
//
// all four, or none. Before ADR-027 the front door wrote the last three and
// kept no record of the REQUEST, so a retried POST — the normal behaviour of
// a flaky kiosk link, a mobile network, or any client with a retry policy —
// filed a second application for the same citizen. Nothing in the system
// said no.
//
// Five outcomes, and the distinction between the last four is the whole
// point:
//
//   RECORDED        first time this key is seen → filed + announced.
//   REPLAYED        same key, same canonical hash → the FIRST result,
//                   returned again. Nothing written, nothing announced.
//   KEY_REUSED      same key, DIFFERENT canonical hash → refused. Replaying
//                   would hand back the wrong application; filing would spend
//                   one key on two submissions.
//   ALREADY_APPLIED a different key, but this citizen already holds a live
//                   application for this campaign + category. The engine
//                   guarantees it (rls/0022's uq_*_live_intent partial unique
//                   index); this is that guarantee surfaced as an answer
//                   rather than a 500.
//   NO_OPEN_CAMPAIGN cancellation won the campaign-row lock race after the
//                   campaign reader's earlier pre-check; nothing was filed.
//
// Like every other business outcome in this service, all five are RETURN
// VALUES. Only infrastructure faults throw.
// ══════════════════════════════════════════════════════════════════

import type { Agency, ApplicationCategory, ApplicationChannel } from '@usrp/shared-types';
import type { StageEvents } from './event-outbox.js';

/** Everything one idempotent submission needs, with its request identity. */
export interface RecordSubmissionInput {
  readonly agency: Agency;
  readonly applicantId: string;
  /** Client-supplied (or server-minted) request key. Half of the ledger PK. */
  readonly idempotencyKey: string;
  /** Canonical SHA-256 of the business content — see domain/request-hash.ts. */
  readonly requestHash: string;
  readonly campaignId: string;
  readonly category: ApplicationCategory;
  readonly channel: ApplicationChannel;
  readonly nesaIndexNumber: string | null;
  readonly hecRegistrationNumber: string | null;
  /** Correlation id of the causal chain — recorded on the history row. */
  readonly correlationId: string;
}

/** The identifiers a citizen is given back, however the request resolved. */
export interface SubmissionIdentifiers {
  readonly applicationId: string;
  readonly processingCode: string;
}

export type RecordSubmissionOutcome =
  /** Filed for the first time; the caller's events were staged. */
  | ({ readonly kind: 'RECORDED' } & SubmissionIdentifiers)
  /**
   * This exact request was already accepted. The original identifiers are
   * returned verbatim and NOTHING is written — in particular no second
   * APPLICANT_SUBMITTED, because the first one is already durable in the
   * outbox and the relay owns its delivery.
   */
  | ({ readonly kind: 'REPLAYED' } & SubmissionIdentifiers & { readonly firstSeenAt: Date })
  /** The key is spent on a materially different request. Nothing written. */
  | { readonly kind: 'KEY_REUSED' }
  /**
   * A live application for this (applicant, campaign, category) already
   * exists under a DIFFERENT request key. Its identifiers are returned so the
   * citizen can be told which application they already hold.
   */
  | ({ readonly kind: 'ALREADY_APPLIED' } & SubmissionIdentifiers)
  /** Cancellation won the campaign row-lock race; the new submission is refused. */
  | { readonly kind: 'NO_OPEN_CAMPAIGN' };

/**
 * What a previously-answered key implies, with no write attempted.
 *
 * `null` means unseen — the caller must go on and file the submission.
 */
export type ResolveKeyOutcome =
  | ({ readonly kind: 'REPLAYED'; readonly firstSeenAt: Date } & SubmissionIdentifiers)
  | { readonly kind: 'KEY_REUSED' };

export interface SubmissionLedger {
  /**
   * Answer a key we have already answered, WITHOUT touching anything mutable.
   *
   * This exists because of an ordering defect. `recordSubmission` also
   * resolves a re-presented key, but only after the use case has already read
   * the applicant's identity and resolved an OPEN campaign — so a retry that
   * arrived after the registration window closed was answered
   * `NO_OPEN_CAMPAIGN`, and a citizen whose first response was lost on a
   * dropped connection was told they had never applied. The retry contract has
   * to be independent of state that moves underneath it.
   *
   * Read-only and keyed on the ledger's primary key, so it is one index probe.
   * It does NOT replace the in-transaction check in `recordSubmission`: that
   * one is the serialisation point for concurrent same-key deliveries, which
   * no pre-check can close.
   */
  resolveKey(input: {
    readonly applicantId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<ResolveKeyOutcome | null>;

  /**
   * Record + file + announce, atomically (see the header). `stage` is invoked
   * INSIDE the transaction and ONLY for a RECORDED outcome — a replay, a
   * reused key and a duplicate announce nothing. It must be PURE: mint the
   * envelope before the call so the staged event and the dispatched one are
   * the same event with the same eventId.
   */
  recordSubmission(
    input: RecordSubmissionInput,
    stage: StageEvents<SubmissionIdentifiers>,
  ): Promise<RecordSubmissionOutcome>;
}
