// ══════════════════════════════════════════════════════════════════
// @usrp/shared-events — Dead-letter replay (operator tool, ADR-025)
//
// Reads events.dead-letter from the beginning up to its CURRENT end, selects
// the letters parked by one consumer group (optionally one source topic), and
// re-publishes each one's ORIGINAL key + bytes to its ORIGINAL topic.
//
// DRY RUN BY DEFAULT. Nothing is produced unless --execute is passed.
//
// Know what replay means before you run it:
//   • It re-publishes to the source TOPIC, so EVERY group on that topic sees
//     the event again, not only the one that failed. USRP consumers are
//     idempotent by contract (projections return NO_CHANGE on redelivery), so
//     this is safe, but it is not free.
//   • Fix the cause first. Replaying into the same bug just parks it again.
//   • UNDECODABLE letters are skipped unless --include-undecodable: bytes that
//     failed to decode will fail again unless the serializer changed.
//
//   npx tsx packages/shared-events/scripts/replay-dead-letters.ts \
//     --group application-service [--source-topic vetting.rib] \
//     [--include-undecodable] [--execute]
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { Kafka, logLevel, type IHeaders } from 'kafkajs';
import { DEAD_LETTER_TOPIC, DLQ_HEADERS } from '../src/index.js';

const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(',');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const GROUP = arg('--group');
const SOURCE_TOPIC = arg('--source-topic');
const EXECUTE = process.argv.includes('--execute');
const INCLUDE_UNDECODABLE = process.argv.includes('--include-undecodable');

function header(headers: IHeaders | undefined, name: string): string | undefined {
  const raw = headers?.[name];
  if (raw === undefined) return undefined;
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first === undefined ? undefined : first.toString();
}

interface Letter {
  readonly sourceTopic: string;
  readonly reason: string;
  readonly eventId: string | undefined;
  readonly key: Buffer | null;
  readonly value: Buffer;
}

async function main(): Promise<void> {
  if (GROUP === undefined) {
    console.error('usage: replay-dead-letters.ts --group <consumer-group> [--source-topic <t>] [--include-undecodable] [--execute]');
    process.exit(2);
  }

  const kafka = new Kafka({ clientId: 'usrp-dlq-replay', brokers: BROKERS, logLevel: logLevel.ERROR });
  const admin = kafka.admin();
  await admin.connect();
  // Snapshot the end of the log NOW: letters parked while we run are not ours.
  const ends = new Map<number, bigint>();
  for (const p of await admin.fetchTopicOffsets(DEAD_LETTER_TOPIC)) ends.set(p.partition, BigInt(p.high));
  await admin.disconnect();

  const pending = new Set([...ends].filter(([, high]) => high > 0n).map(([partition]) => partition));
  const letters: Letter[] = [];

  if (pending.size > 0) {
    const consumer = kafka.consumer({ groupId: `usrp-dlq-replay-${randomUUID()}` });
    await consumer.connect();
    await consumer.subscribe({ topics: [DEAD_LETTER_TOPIC], fromBeginning: true });
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await consumer.run({
      eachMessage: async ({ partition, message }): Promise<void> => {
        const end = ends.get(partition) ?? 0n;
        if (BigInt(message.offset) < end && message.value !== null) {
          const group = header(message.headers, DLQ_HEADERS.GROUP);
          const sourceTopic = header(message.headers, DLQ_HEADERS.SOURCE_TOPIC);
          const reason = header(message.headers, DLQ_HEADERS.REASON) ?? 'UNKNOWN';
          const selected =
            group === GROUP &&
            sourceTopic !== undefined &&
            (SOURCE_TOPIC === undefined || sourceTopic === SOURCE_TOPIC) &&
            (INCLUDE_UNDECODABLE || reason !== 'UNDECODABLE');
          if (selected) {
            letters.push({
              sourceTopic,
              reason,
              eventId: header(message.headers, DLQ_HEADERS.EVENT_ID),
              key: message.key,
              value: message.value,
            });
          }
        }
        if (BigInt(message.offset) + 1n >= end) pending.delete(partition);
        if (pending.size === 0) finish();
      },
    });
    await done;
    await consumer.disconnect();
  }

  console.log(JSON.stringify({ msg: 'dlq_replay_selected', group: GROUP, sourceTopic: SOURCE_TOPIC ?? '*', count: letters.length, execute: EXECUTE }));
  for (const l of letters) {
    console.log(JSON.stringify({ msg: 'dlq_letter', sourceTopic: l.sourceTopic, reason: l.reason, eventId: l.eventId ?? null }));
  }

  if (!EXECUTE) {
    console.log('dry run: nothing re-published. Re-run with --execute once the cause is fixed.');
    return;
  }

  const producer = kafka.producer({ allowAutoTopicCreation: false });
  await producer.connect();
  for (const l of letters) {
    await producer.send({
      topic: l.sourceTopic,
      messages: [{ key: l.key, value: l.value, headers: { 'x-usrp-replayed-from-dlq': 'true' } }],
    });
  }
  await producer.disconnect();
  console.log(JSON.stringify({ msg: 'dlq_replay_done', republished: letters.length }));
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('DLQ REPLAY FAILED:', err);
    process.exit(1);
  });
