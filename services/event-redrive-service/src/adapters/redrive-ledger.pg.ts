// ══════════════════════════════════════════════════════════════════
// event-redrive-service — RedriveLedger adapter (PostgreSQL, D2)
//
// public_core.event_redrive_ledger (rls/0045). Every statement runs as
// usrp_system_service, the role the worker is: operational state, not case data.
//
// THE CLAIM IS THE CONCURRENCY CONTROL. `FOR UPDATE SKIP LOCKED` means two
// workers — a second instance, or one slow tick overlapping the next — never
// claim the same letter: the loser moves on instead of blocking, so a long
// backlog cannot serialise the fleet.
//
// Offsets are bigint in Postgres and STRINGS here. A Kafka offset is a 64-bit
// value and JS numbers lose precision above 2^53; the ledger's UNIQUE key is
// built from it, so a rounded offset would silently collide two letters.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { DEAD_LETTER_TOPIC, firstDueAtMs, type RedriveLedgerEntry, type RedriveParkReason } from '@usrp/shared-events';
import type { ClaimDueInput, IntakeInput, ParkInput, RecordAttemptInput, RedriveLedger } from '../ports/redrive-ledger.js';

const SYSTEM_ROLE = 'usrp_system_service';

interface LedgerRow {
  readonly source_topic: string;
  readonly source_partition: number;
  readonly source_offset: string;
  readonly group_id: string;
  readonly reason: string;
  readonly attempts: number;
  readonly consecutive_group_failures: number;
  readonly state: string;
  readonly next_attempt_at: Date;
}

function toEntry(row: LedgerRow): RedriveLedgerEntry {
  return {
    sourceTopic: row.source_topic,
    sourcePartition: row.source_partition,
    sourceOffset: row.source_offset,
    groupId: row.group_id,
    reason: row.reason as RedriveLedgerEntry['reason'],
    attempts: row.attempts,
    consecutiveGroupFailures: row.consecutive_group_failures,
    state: row.state as RedriveLedgerEntry['state'],
    nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
  };
}

export class PgRedriveLedger implements RedriveLedger {
  async readCursor(topic: string): Promise<ReadonlyMap<number, string>> {
    return sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
      const rows = await tx<{ partition: number; next_offset: string }[]>`
        SELECT partition, next_offset::text AS next_offset
        FROM public_core.event_redrive_cursor WHERE topic = ${topic}
      `;
      return new Map(rows.map((r) => [r.partition, r.next_offset] as const));
    });
  }

  async intake(input: IntakeInput): Promise<{ readonly registered: number }> {
    return sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
      let registered = 0;
      for (const l of input.letters) {
        // prior = what the same event already spent in this group. The new row
        // inherits it (attempts, first_seen_at); WHEN it is due is the pure
        // schedule's call (firstDueAtMs), not a second copy of the rule in SQL.
        const prior =
          l.eventId === null
            ? []
            : await tx<{ attempts: number; first_seen: Date | null }[]>`
                SELECT COALESCE(MAX(attempts), 0) AS attempts, MIN(first_seen_at) AS first_seen
                FROM public_core.event_redrive_ledger
                WHERE group_id = ${l.groupId} AND event_id = ${l.eventId}
              `;
        const attempts = prior[0]?.attempts ?? 0;
        const firstSeenMs = prior[0]?.first_seen ? new Date(prior[0].first_seen).getTime() : input.nowMs;
        const dueMs = firstDueAtMs({ delaysMs: input.delaysMs, groupFailureThreshold: 1, maxPerTick: 1 }, input.nowMs, l.reason, attempts);
        const inserted = await tx`
          INSERT INTO public_core.event_redrive_ledger
            (source_topic, source_partition, source_offset, group_id, reason, event_id,
             attempts, first_seen_at, next_attempt_at)
          VALUES (${l.sourceTopic}, ${l.partition}, ${l.offset}::bigint, ${l.groupId}, ${l.reason}, ${l.eventId},
                  ${attempts}, to_timestamp(${firstSeenMs / 1000}), to_timestamp(${dueMs / 1000}))
          ON CONFLICT (source_topic, source_partition, source_offset, group_id) DO NOTHING
        `;
        registered += inserted.count;
      }
      for (const [partition, nextOffset] of input.next) {
        await tx`
          INSERT INTO public_core.event_redrive_cursor (topic, partition, next_offset)
          VALUES (${DEAD_LETTER_TOPIC}, ${partition}, ${nextOffset}::bigint)
          ON CONFLICT (topic, partition) DO UPDATE
            SET next_offset = GREATEST(public_core.event_redrive_cursor.next_offset, EXCLUDED.next_offset),
                updated_at = now()
        `;
      }
      return { registered };
    });
  }

  async claimDue(input: ClaimDueInput): Promise<readonly RedriveLedgerEntry[]> {
    return sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
      const rows = await tx<LedgerRow[]>`
        SELECT source_topic, source_partition, source_offset::text AS source_offset,
               group_id, reason, attempts, consecutive_group_failures, state, next_attempt_at
        FROM public_core.event_redrive_ledger
        WHERE state = 'RETRYING' AND next_attempt_at <= to_timestamp(${input.nowMs / 1000})
        ORDER BY next_attempt_at ASC
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
      `;
      return rows.map(toEntry);
    });
  }

  async recordSuccess(entry: RedriveLedgerEntry, nowMs: number): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
      await tx`
        UPDATE public_core.event_redrive_ledger SET
          state = 'REDRIVEN',
          attempts = attempts + 1,
          last_attempt_at = to_timestamp(${nowMs / 1000}),
          -- The handler works again: the group's streak is over.
          consecutive_group_failures = 0,
          last_error_code = NULL
        WHERE source_topic = ${entry.sourceTopic}
          AND source_partition = ${entry.sourcePartition}
          AND source_offset = ${entry.sourceOffset}::bigint
          AND group_id = ${entry.groupId}
      `;
    });
  }

  async recordFailure(input: RecordAttemptInput): Promise<void> {
    const { entry, nowMs } = input;
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
      await tx`
        UPDATE public_core.event_redrive_ledger SET
          attempts = attempts + 1,
          consecutive_group_failures = consecutive_group_failures + 1,
          last_attempt_at = to_timestamp(${nowMs / 1000}),
          next_attempt_at = to_timestamp(${input.nextAttemptAtMs / 1000}),
          last_error_code = ${input.errorCode ?? null}
        WHERE source_topic = ${entry.sourceTopic}
          AND source_partition = ${entry.sourcePartition}
          AND source_offset = ${entry.sourceOffset}::bigint
          AND group_id = ${entry.groupId}
      `;
    });
    // The breaker is per (group, topic): every OTHER letter of a broken group
    // inherits the streak, which is the whole point of counting it per group.
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
      await tx`
        UPDATE public_core.event_redrive_ledger SET
          consecutive_group_failures = consecutive_group_failures + 1
        WHERE group_id = ${entry.groupId}
          AND source_topic = ${entry.sourceTopic}
          AND state = 'RETRYING'
          AND NOT (source_partition = ${entry.sourcePartition} AND source_offset = ${entry.sourceOffset}::bigint)
      `;
    });
  }

  async park(input: ParkInput): Promise<void> {
    const { entry } = input;
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
      await tx`
        UPDATE public_core.event_redrive_ledger SET
          state = 'PARKED',
          parked_reason = ${input.reason satisfies RedriveParkReason},
          parked_at = to_timestamp(${input.nowMs / 1000}),
          last_error_code = ${input.errorCode ?? null}
        WHERE source_topic = ${entry.sourceTopic}
          AND source_partition = ${entry.sourcePartition}
          AND source_offset = ${entry.sourceOffset}::bigint
          AND group_id = ${entry.groupId}
          AND state = 'RETRYING'
      `;
    });
  }
}
