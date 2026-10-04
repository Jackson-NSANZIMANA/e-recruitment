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
// Four outcomes, and the distinction between the last three is the whole
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
//
// Like every other business outcome in this service, all four are RETURN
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
  | ({ readonly kind: 'ALREADY_APPLIED' } & SubmissionIdentifiers);

export interface SubmissionLedger {
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
