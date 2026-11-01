// ══════════════════════════════════════════════════════════════════
// event-redrive-service — DeadLetterSource / RawRepublisher ports
//
// The worker must move OPAQUE BYTES, not events: a re-drive is byte-exact
// (ADR-050 §3.4), and an UNDECODABLE letter could not survive a decode/encode
// round trip even if we wanted one. So both sides of the worker speak raw.
//
// Reading is by IDENTITY (topic/partition/offset), which is what the ledger
// stores: the worker never scans the topic, it fetches the one letter it has a
// row for. That keeps a re-drive's cost independent of the backlog.
// ══════════════════════════════════════════════════════════════════

import type { DeadLetterHeader, RedriveLedgerEntry } from '@usrp/shared-events';

/** The original bytes of one dead letter. */
export interface DeadLetterMessage {
  readonly key: Buffer | null;
  readonly value: Buffer;
  /** The letter's headers, so the re-publish stays faithful. */
  readonly headers: Readonly<Record<string, string>>;
}

/** One intake pass: the letters registered and where each DLQ partition now stands. */
export interface ScanResult {
  readonly letters: readonly DeadLetterHeader[];
  /** partition → next offset to read. Advanced past letters with unreadable headers too. */
  readonly next: ReadonlyMap<number, string>;
}

export interface DeadLetterSource {
  /**
   * Read the dead-letter topic FORWARD from `cursor` (partition → next offset;
   * absent = from the beginning), up to `limit` letters and a snapshot of the
   * topic's end. Returns identity and headers only — the bytes are fetched later,
   * and only for letters that are actually re-driven. Without this pass nothing
   * ever creates a ledger row and the worker has nothing to claim.
   */
  scanNew(cursor: ReadonlyMap<number, string>, limit: number): Promise<ScanResult>;

  /**
   * The original bytes for each of `entries`, keyed by `redriveKey()`.
   *
   * ONE PASS PER TICK, not one seek per letter: the graveyard is read
   * sequentially up to a snapshot of its end, exactly as the operator tool
   * does, and identities the ledger asked about are lifted out of that pass. A
   * seek-per-letter would cost a broker round trip per re-drive and leave the
   * topic's retention racing the worker.
   *
   * An entry absent from the map is a PARK-worthy fact, not an error: retrying
   * an identity that no longer exists is a loop.
   */
  fetchBatch(entries: readonly RedriveLedgerEntry[]): Promise<ReadonlyMap<string, DeadLetterMessage>>;
}

export interface RawRepublisher {
  /** Re-publish the ORIGINAL key/bytes to the ORIGINAL topic + provenance header. */
  replay(sourceTopic: string, message: DeadLetterMessage): Promise<void>;
  /** Park the parked-signal for the officer path / alerting (one small event). */
  parkSignal(payload: Record<string, unknown>): Promise<void>;
  disconnect(): Promise<void>;
}
