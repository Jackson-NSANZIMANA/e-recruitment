// ══════════════════════════════════════════════════════════════════
// event-redrive-service — RedriveLedger port (D2, ADR-050 §3.3)
//
// The ledger is the SCHEDULE. Kafka offsets are a cursor: "the end of the log"
// answers "how far did we read", never "who is due at 03:00". So the durable
// state of a re-drive lives in a table with one row per letter and a
// next_attempt_at per row, and this port is the only way in.
//
// The two write methods after a re-drive are separate ON PURPOSE:
//   • recordSuccess — the letter was republished and nothing complained; the
//     group's consecutive-failure counter RESETS, because the handler works;
//   • recordFailure — republishing failed (transport) or the letter came back
//     (a new dead letter for the same identity); the counter advances and the
//     next attempt is scheduled.
// Conflating them is how a circuit breaker either never trips or never resets.
// ══════════════════════════════════════════════════════════════════

import type { RedriveLedgerEntry, RedriveParkReason } from '@usrp/shared-events';

export interface ClaimDueInput {
  readonly nowMs: number;
  readonly limit: number;
}

export interface RecordAttemptInput {
  readonly entry: RedriveLedgerEntry;
  readonly nowMs: number;
  /** Scheduled instant for the NEXT attempt, when this one failed. */
  readonly nextAttemptAtMs: number;
  /** Closed code from the failure, if any — never a message. */
  readonly errorCode?: string;
}

export interface ParkInput {
  readonly entry: RedriveLedgerEntry;
  readonly reason: RedriveParkReason;
  readonly nowMs: number;
  readonly errorCode?: string;
}

export interface RedriveLedger {
  /**
   * Every RETRYING letter whose next_attempt_at has passed, oldest first, up to
   * `limit`, claimed under a row lock (`FOR UPDATE SKIP LOCKED`) so a second
   * worker — or a slow tick — cannot claim the same letter twice.
   */
  claimDue(input: ClaimDueInput): Promise<readonly RedriveLedgerEntry[]>;
  /**
   * A republish that was accepted: the row settles (state REDRIVEN, attempts+1)
   * and the group's consecutive-failure counter RESETS, because the handler
   * demonstrably works again.
   */
  recordSuccess(entry: RedriveLedgerEntry, nowMs: number): Promise<void>;
  /** A republish that failed: attempts+1, group counter+1, rescheduled. */
  recordFailure(input: RecordAttemptInput): Promise<void>;
  park(input: ParkInput): Promise<void>;
}
