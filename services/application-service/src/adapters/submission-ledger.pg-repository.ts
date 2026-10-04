// ══════════════════════════════════════════════════════════════════
// application-service — PgSubmissionLedger (PostgreSQL, ADR-027)
//
// recordSubmission() is ONE transaction as usrp_system_service:
//
//   1. Has this (applicant, idempotency key) been seen?
//        hash matches    → REPLAYED with the stored identifiers.
//        hash differs    → KEY_REUSED. Nothing written.
//   2. Does a LIVE application already exist for this campaign + category?
//        → ALREADY_APPLIED with that application's identifiers. (Fast path;
//          the engine's index below is what actually guarantees it.)
//   3. Mint the identifiers, then INSERT THE LEDGER ROW FIRST.
//      This is the ordering decision of the slice. The ledger's primary key
//      is (applicant_id, idempotency_key), so two concurrent deliveries of
//      the SAME request meet on that key: the second blocks on the first's
//      uncommitted speculative insert, and when the first commits it takes
//      the DO NOTHING branch and REPLAYS. Had we inserted the application
//      first, both would already have filed before either reached the key.
//   4. INSERT the application with those explicit identifiers, then its
//      opening history row.
//   5. Stage APPLICANT_SUBMITTED in the outbox. LAST, so nothing after it
//      can fail and leave an announcement for a rolled-back submission.
//
// THE CONCURRENT-DUPLICATE RACE (step 4). Two DIFFERENT keys for the same
// citizen+campaign+category pass step 2 together and both reach the insert.
// One wins; the other gets 23505 on uq_<agency>_applications_live_intent and
// Postgres aborts its whole transaction — so it cannot be answered from
// inside. It is caught OUTSIDE, in a fresh read-only transaction that fetches
// the winner and answers ALREADY_APPLIED. The loser's ledger row rolled back
// with it, so its key is unspent and a genuine retry still behaves correctly.
//
// Infrastructure faults throw ApplicationPersistenceError, which the HTTP
// adapter maps to a 500 with no internals leaked.
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { sql, type SqlTransaction } from '@usrp/shared-database';
import type {
  RecordSubmissionInput,
  RecordSubmissionOutcome,
  ResolveKeyOutcome,
  SubmissionIdentifiers,
  SubmissionLedger,
} from '../ports/submission-ledger.js';
import type { StageEvents } from '../ports/event-outbox.js';
import { ApplicationPersistenceError } from '../domain/application.errors.js';
import { AGENCY_TARGET, type AgencyTarget } from '../domain/agency-schema.js';
import {
  findLiveApplication,
  insertOpeningHistory,
  insertSubmittedApplication,
  isLiveIntentViolation,
  mintProcessingCode,
} from './application-insert.js';
import { stageEvents } from './outbox/pg-event-outbox.js';

const SYSTEM_ROLE = 'usrp_system_service';

/** The ledger row as stored. */
interface LedgerRow {
  readonly request_hash: string;
  readonly application_id: string;
  readonly processing_code: string;
  readonly created_at: Date;
}

/** The ledger entry for one request key, or undefined when unseen. */
async function ledgerEntry(
  tx: SqlTransaction,
  applicantId: string,
  idempotencyKey: string,
): Promise<LedgerRow | undefined> {
  const rows = await tx<LedgerRow[]>`
    SELECT request_hash, application_id, processing_code, created_at
    FROM public_core.submission_requests
    WHERE applicant_id = ${applicantId} AND idempotency_key = ${idempotencyKey}
  `;
  return rows[0];
}

/** A stored entry → the outcome it implies for a re-presented key. */
function replayOrRefuse(entry: LedgerRow, requestHash: string): RecordSubmissionOutcome {
  if (entry.request_hash !== requestHash) return { kind: 'KEY_REUSED' };
  return {
    kind: 'REPLAYED',
    applicationId: entry.application_id,
    processingCode: entry.processing_code,
    firstSeenAt: entry.created_at,
  };
}

export class PgSubmissionLedger implements SubmissionLedger {
  /**
   * The pre-check. See the port docs for why it exists: a retry must be
   * answerable from the ledger alone, before any mutable read can contradict
   * it. Read-only, one probe on the ledger's primary key.
   */
  async resolveKey(input: {
    readonly applicantId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<ResolveKeyOutcome | null> {
    try {
      return await sql.begin(async (tx): Promise<ResolveKeyOutcome | null> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        await tx`SET LOCAL TRANSACTION READ ONLY`;
        const seen = await ledgerEntry(tx, input.applicantId, input.idempotencyKey);
        if (seen === undefined) return null;
        // replayOrRefuse is shared with recordSubmission so the two paths can
        // never disagree about what a stored entry means. A STORED entry only
        // ever implies one of these two.
        const outcome = replayOrRefuse(seen, input.requestHash);
        if (outcome.kind === 'REPLAYED') {
          return {
            kind: 'REPLAYED',
            applicationId: outcome.applicationId,
            processingCode: outcome.processingCode,
            firstSeenAt: outcome.firstSeenAt,
          };
        }
        return { kind: 'KEY_REUSED' };
      });
    } catch (err) {
      throw new ApplicationPersistenceError('Could not read the submission ledger', {
        cause: err,
      });
    }
  }

  async recordSubmission(
    input: RecordSubmissionInput,
    stage: StageEvents<SubmissionIdentifiers>,
  ): Promise<RecordSubmissionOutcome> {
    const target = AGENCY_TARGET[input.agency];

    try {
      return await sql.begin(async (tx): Promise<RecordSubmissionOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        // 1. A key we have already answered.
        const seen = await ledgerEntry(tx, input.applicantId, input.idempotencyKey);
        if (seen !== undefined) return replayOrRefuse(seen, input.requestHash);

        // 2. A live application under some OTHER key.
        const live = await findLiveApplication(
          tx,
          target,
          input.applicantId,
          input.campaignId,
          input.category,
        );
        if (live !== null) {
          // READ COMMITTED gives every statement a fresh snapshot, so a
          // concurrent delivery of THIS SAME request can commit between step 1
          // and step 2: step 1 saw no ledger row, step 2 now sees that
          // request's application. Answering ALREADY_APPLIED there would be
          // wrong — the caller sent the key it was given a result for, and is
          // owed that result. Re-read the key before concluding it is someone
          // else's application. (Found by verify-submission-integrity.ts §5a,
          // where 1 of 8 identical concurrent retries hit exactly this window.)
          const raced = await ledgerEntry(tx, input.applicantId, input.idempotencyKey);
          if (raced !== undefined) return replayOrRefuse(raced, input.requestHash);
          return { kind: 'ALREADY_APPLIED', ...live };
        }

        // 3. Identifiers first, then the ledger row — the serialisation point.
        const identifiers: SubmissionIdentifiers = {
          applicationId: randomUUID(),
          processingCode: await mintProcessingCode(tx, target),
        };

        const claimed = await tx<{ idempotency_key: string }[]>`
          INSERT INTO public_core.submission_requests
            (applicant_id, idempotency_key, request_hash, agency, application_id, processing_code)
          VALUES (
            ${input.applicantId},
            ${input.idempotencyKey},
            ${input.requestHash},
            ${input.agency}::public_core.agency,
            ${identifiers.applicationId},
            ${identifiers.processingCode}
          )
          ON CONFLICT (applicant_id, idempotency_key) DO NOTHING
          RETURNING idempotency_key
        `;

        if (claimed[0] === undefined) {
          // A concurrent delivery of this same request committed while we
          // waited on the key. Answer with ITS result, never a second filing.
          const winner = await ledgerEntry(tx, input.applicantId, input.idempotencyKey);
          if (winner === undefined) {
            throw new ApplicationPersistenceError(
              'submission_requests conflict reported but no winning row is visible',
            );
          }
          return replayOrRefuse(winner, input.requestHash);
        }

        // 4. The application + its opening trail entry, under the claimed key.
        await insertSubmittedApplication(tx, target, input, identifiers);
        await insertOpeningHistory(tx, target, identifiers.applicationId, input.correlationId);

        // 5. The announcement commits WITH the filing, or neither does.
        await stageEvents(tx, stage(identifiers));

        return { kind: 'RECORDED', ...identifiers };
      });
    } catch (cause) {
      // The engine refused a second live application. The transaction above is
      // already dead, so the answer is resolved in a fresh one.
      if (isLiveIntentViolation(cause)) {
        return await this.#resolveLiveDuplicate(target, input);
      }
      if (cause instanceof ApplicationPersistenceError) throw cause;
      throw new ApplicationPersistenceError('Failed to record the submission', { cause });
    }
  }

  /**
   * Name the application that won the live-intent race. A null result would
   * mean the winner was withdrawn between the refusal and this read — rare,
   * and genuinely transient, so it surfaces as a fault the client may retry
   * rather than as a duplicate answer with no application to point at.
   */
  async #resolveLiveDuplicate(
    target: AgencyTarget,
    input: RecordSubmissionInput,
  ): Promise<RecordSubmissionOutcome> {
    try {
      const winner = await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        return await findLiveApplication(
          tx,
          target,
          input.applicantId,
          input.campaignId,
          input.category,
        );
      });
      if (winner === null) {
        throw new ApplicationPersistenceError(
          'live-intent conflict reported but no live application is visible',
        );
      }
      return { kind: 'ALREADY_APPLIED', ...winner };
    } catch (cause) {
      if (cause instanceof ApplicationPersistenceError) throw cause;
      throw new ApplicationPersistenceError('Failed to resolve a duplicate submission', { cause });
    }
  }
}
