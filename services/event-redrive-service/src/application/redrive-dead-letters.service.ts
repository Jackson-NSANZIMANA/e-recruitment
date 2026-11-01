// ══════════════════════════════════════════════════════════════════
// event-redrive-service — RedriveDeadLetters use case (D2, ADR-050)
//
// ONE TICK, in order:
//
//   1. claim due letters (the ledger decides WHO; this decides nothing);
//   2. for each, ask the PURE policy (decideRedrive) what it means — the
//      decision is not re-derived here, so the schedule can be argued about in
//      a test file rather than in production;
//   3. REDRIVE → fetch the original bytes → re-publish byte-exact → record
//      success (or record failure and let the circuit breaker count it);
//      PARK → record the parked reason and emit the parked signal;
//      WAIT/SKIP → nothing (the row is already right).
//
// WHAT THE WORKER NEVER DOES:
//   • it never decodes an event, so an UNDECODABLE letter is no harder than a
//     HANDLER_FAILED one and no serializer assumption leaks in;
//   • it never mutates domain state — re-driving the EVENT re-runs the
//     consumer's idempotent handler, which is the only thing allowed to change
//     a citizen's case (ADR-006);
//   • it never decides "this is hopeless" on its own: the cap, the closed
//     reasons and the breaker are all in the pure policy.
//
// A FAILED REPUBLISH IS NOT A FAILED LETTER. Transport errors count against the
// group breaker and reschedule; they are not evidence about the event.
// ══════════════════════════════════════════════════════════════════

import {
  DEAD_LETTER_TOPIC,
  decideRedrive,
  nextAttemptAtMs,
  redriveKey,
  type RedriveDecision,
  type RedriveLedgerEntry,
  type RedriveParkReason,
  type RedrivePolicy,
} from '@usrp/shared-events';
import type { RedriveLedger } from '../ports/redrive-ledger.js';
import type { DeadLetterMessage, DeadLetterSource, RawRepublisher } from '../ports/dead-letter-source.js';

export interface RedriveDeps {
  readonly ledger: RedriveLedger;
  readonly source: DeadLetterSource;
  readonly republisher: RawRepublisher;
  readonly policy: RedrivePolicy;
  /** Injected so a proof can move time without sleeping. */
  readonly now: () => number;
  /** Redacting logger line emitter (the service's single sink). */
  readonly log: (line: Record<string, unknown>) => void;
}

/** Closed set of per-tick outcomes, so a proof can assert on counts. */
export interface RedriveTickResult {
  readonly claimed: number;
  readonly replayed: number;
  readonly parked: number;
  readonly waiting: number;
  readonly skipped: number;
  readonly failed: number;
}

const ZERO: RedriveTickResult = {
  claimed: 0,
  replayed: 0,
  parked: 0,
  waiting: 0,
  skipped: 0,
  failed: 0,
};

export class RedriveDeadLettersService {
  readonly #deps: RedriveDeps;

  constructor(deps: RedriveDeps) {
    this.#deps = deps;
  }

  /**
   * Register what landed on the dead-letter topic since the last pass. This is
   * the step that makes the ledger non-empty: before it existed the worker
   * claimed from a table nothing wrote to. A broker hiccup here must not stop the
   * letters already on the schedule from being re-driven, so it is logged and
   * the tick continues.
   */
  async #intake(nowMs: number): Promise<void> {
    try {
      const cursor = await this.#deps.ledger.readCursor(DEAD_LETTER_TOPIC);
      const scan = await this.#deps.source.scanNew(cursor, this.#deps.policy.maxPerTick * 4);
      if (scan.letters.length === 0 && scan.next.size === 0) return;
      const { registered } = await this.#deps.ledger.intake({
        letters: scan.letters,
        next: scan.next,
        nowMs,
        delaysMs: this.#deps.policy.delaysMs,
      });
      if (registered > 0) this.#deps.log({ msg: 'event_redrive_intake', registered });
    } catch (error) {
      this.#deps.log({ msg: 'event_redrive_intake_failed', error: error instanceof Error ? error.name : 'unknown' });
    }
  }

  /** One pass. Returns counts; never throws for a single letter's failure. */
  async tick(): Promise<RedriveTickResult> {
    const nowMs = this.#deps.now();
    await this.#intake(nowMs);
    const due = await this.#deps.ledger.claimDue({ nowMs, limit: this.#deps.policy.maxPerTick });
    const counts = { ...ZERO, claimed: due.length };

    // Decide FIRST, then fetch only what will actually be re-driven: one
    // sequential pass over the graveyard per tick, never one seek per letter.
    const decisions = due.map((entry) => ({ entry, decision: decideRedrive(entry, nowMs, this.#deps.policy) }));
    const toReplay = decisions.filter((d) => d.decision.kind === 'REDRIVE').map((d) => d.entry);
    const letters =
      toReplay.length === 0 ? new Map<string, DeadLetterMessage>() : await this.#deps.source.fetchBatch(toReplay);

    for (const { entry, decision } of decisions) {
      switch (decision.kind) {
        case 'SKIP':
          counts.skipped += 1;
          break;
        case 'WAIT':
          counts.waiting += 1;
          break;
        case 'PARK':
          await this.#park(entry, decision.reason, nowMs);
          counts.parked += 1;
          break;
        case 'REDRIVE': {
          const outcome = await this.#redrive(entry, decision, nowMs, letters.get(redriveKey(entry)) ?? null);
          if (outcome === 'REPLAYED') counts.replayed += 1;
          else counts.failed += 1;
          break;
        }
      }
    }
    return counts;
  }

  async #redrive(
    entry: RedriveLedgerEntry,
    decision: Extract<RedriveDecision, { kind: 'REDRIVE' }>,
    nowMs: number,
    message: DeadLetterMessage | null,
  ): Promise<'REPLAYED' | 'FAILED'> {
    if (message === null) {
      // The letter is gone (retention / compaction). Retrying an identity that
      // no longer exists is a loop, so it is parked with a closed reason.
      await this.#park(entry, 'ATTEMPTS_EXHAUSTED', nowMs, 'LETTER_GONE');
      this.#deps.log({
        msg: 'event_redrive_letter_missing',
        group: entry.groupId,
        topic: entry.sourceTopic,
        partition: entry.sourcePartition,
        offset: entry.sourceOffset,
      });
      return 'FAILED';
    }

    try {
      await this.#deps.republisher.replay(entry.sourceTopic, message);
    } catch (error) {
      const nextAt = nextAttemptAtMs(this.#deps.policy, entry.attempts, nowMs);
      await this.#deps.ledger.recordFailure({
        entry,
        nowMs,
        nextAttemptAtMs: nextAt,
        errorCode: 'REPUBLISH_FAILED',
      });
      this.#deps.log({
        msg: 'event_redrive_publish_failed',
        group: entry.groupId,
        topic: entry.sourceTopic,
        attempt: decision.attempt,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return 'FAILED';
    }

    await this.#deps.ledger.recordSuccess(entry, nowMs);
    this.#deps.log({
      msg: 'event_redriven',
      group: entry.groupId,
      topic: entry.sourceTopic,
      partition: entry.sourcePartition,
      offset: entry.sourceOffset,
      attempt: decision.attempt,
    });
    return 'REPLAYED';
  }

  async #park(
    entry: RedriveLedgerEntry,
    reason: RedriveParkReason,
    nowMs: number,
    errorCode?: string,
  ): Promise<void> {
    await this.#deps.ledger.park({ entry, reason, nowMs, ...(errorCode === undefined ? {} : { errorCode }) });
    // The parked signal is ONE auditable fact per letter: alerting rides an
    // existing stream instead of a new one (ADR-050 §2), and the officer path
    // (ADR-051) is what turns it into a decision.
    await this.#deps.republisher.parkSignal({
      groupId: entry.groupId,
      sourceTopic: entry.sourceTopic,
      sourcePartition: entry.sourcePartition,
      sourceOffset: entry.sourceOffset,
      reason,
      attempts: entry.attempts,
    });
    this.#deps.log({
      msg: 'event_dead_letter_parked',
      group: entry.groupId,
      topic: entry.sourceTopic,
      partition: entry.sourcePartition,
      offset: entry.sourceOffset,
      reason,
    });
  }
}
