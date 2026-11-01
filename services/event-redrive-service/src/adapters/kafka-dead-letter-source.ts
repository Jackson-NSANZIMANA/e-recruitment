// ══════════════════════════════════════════════════════════════════
// event-redrive-service — Kafka adapters (D2)
//
// DeadLetterSource: ONE sequential pass over `events.dead-letter` up to a
// snapshot of its end — the same shape as the operator tool, for the same
// reason. Reading by identity ("seek to offset N") would cost a broker round
// trip per letter and race retention; reading the graveyard forward is
// bounded, cheap, and sees exactly what it claims to see.
//
// The end snapshot matters: letters parked WHILE the pass runs are not this
// tick's business, and chasing a moving end is how a worker never returns.
//
// RawRepublisher: byte-exact re-publish with the provenance header, plus the
// parked signal (a small JSON fact on `events.dead-letter-parked`). It never
// decodes an event, so an UNDECODABLE letter is transportable.
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { Kafka, logLevel, type Consumer, type IHeaders } from 'kafkajs';
import {
  DEAD_LETTER_TOPIC,
  DLQ_HEADERS,
  PARKED_TOPIC,
  redriveKey,
  type RedriveLedgerEntry,
} from '@usrp/shared-events';
import type { DeadLetterMessage, DeadLetterSource, RawRepublisher } from '../ports/dead-letter-source.js';

/** Upper bound on one pass: a huge graveyard must not stall the tick forever. */
const PASS_TIMEOUT_MS = 20_000;

function headerValue(headers: IHeaders | undefined, name: string): string | undefined {
  const raw = headers?.[name];
  if (raw === undefined) return undefined;
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first === undefined ? undefined : first.toString();
}

export class KafkaDeadLetterSource implements DeadLetterSource {
  readonly #kafka: Kafka;

  constructor(options: { readonly brokers: readonly string[]; readonly clientId: string; readonly ssl?: boolean }) {
    this.#kafka = new Kafka({
      clientId: options.clientId,
      brokers: [...options.brokers],
      ssl: options.ssl ?? false,
      logLevel: logLevel.ERROR,
    });
  }

  async fetchBatch(entries: readonly RedriveLedgerEntry[]): Promise<ReadonlyMap<string, DeadLetterMessage>> {
    const wanted = new Set(entries.map((entry) => redriveKey(entry)));
    const found = new Map<string, DeadLetterMessage>();
    if (wanted.size === 0) return found;

    const admin = this.#kafka.admin();
    await admin.connect();
    const ends = new Map<number, bigint>();
    try {
      for (const p of await admin.fetchTopicOffsets(DEAD_LETTER_TOPIC)) ends.set(p.partition, BigInt(p.high));
    } finally {
      await admin.disconnect();
    }

    const pending = new Set([...ends].filter(([, high]) => high > 0n).map(([partition]) => partition));
    if (pending.size === 0) return found;

    const consumer: Consumer = this.#kafka.consumer({ groupId: `usrp-redrive-read-${randomUUID()}` });
    await consumer.connect();
    try {
      await consumer.subscribe({ topics: [DEAD_LETTER_TOPIC], fromBeginning: true });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, PASS_TIMEOUT_MS);
        const finish = (): void => {
          clearTimeout(timer);
          resolve();
        };
        consumer
          .run({
            eachMessage: ({ partition, message }): Promise<void> => {
              const end = ends.get(partition) ?? 0n;
              if (BigInt(message.offset) < end && message.value !== null) {
                const key = redriveKey({
                  groupId: headerValue(message.headers, DLQ_HEADERS.GROUP) ?? '',
                  sourceTopic: headerValue(message.headers, DLQ_HEADERS.SOURCE_TOPIC) ?? '',
                  sourcePartition: partition,
                  sourceOffset: message.offset,
                });
                if (wanted.has(key)) {
                  const headers: Record<string, string> = {};
                  for (const [name, value] of Object.entries(message.headers ?? {})) {
                    const single = Array.isArray(value) ? value[0] : value;
                    if (single !== undefined) headers[name] = single.toString();
                  }
                  found.set(key, { key: message.key, value: message.value, headers });
                }
              }
              if (BigInt(message.offset) + 1n >= end) pending.delete(partition);
              if (found.size >= wanted.size || pending.size === 0) finish();
              return Promise.resolve();
            },
          })
          .catch(() => {
            finish();
          });
      });
    } finally {
      await consumer.disconnect();
    }
    return found;
  }
}

export class KafkaRawRepublisher implements RawRepublisher {
  readonly #producer;

  constructor(options: { readonly brokers: readonly string[]; readonly clientId: string; readonly ssl?: boolean }) {
    this.#producer = new Kafka({
      clientId: options.clientId,
      brokers: [...options.brokers],
      ssl: options.ssl ?? false,
      logLevel: logLevel.ERROR,
    }).producer({ allowAutoTopicCreation: false });
  }

  async connect(): Promise<void> {
    await this.#producer.connect();
  }

  async replay(sourceTopic: string, message: DeadLetterMessage): Promise<void> {
    // BYTE-EXACT: the original key and value, unchanged. The one added header
    // is provenance, and it is the SAME header the operator tool writes so a
    // consumer sees one shape whether a human or the schedule re-drove it.
    await this.#producer.send({
      topic: sourceTopic,
      messages: [
        {
          key: message.key,
          value: message.value,
          headers: { ...message.headers, 'x-usrp-replayed-from-dlq': 'true' },
        },
      ],
    });
  }

  async parkSignal(payload: Record<string, unknown>): Promise<void> {
    await this.#producer.send({
      topic: PARKED_TOPIC,
      messages: [{ key: null, value: Buffer.from(JSON.stringify(payload), 'utf8') }],
    });
  }

  async disconnect(): Promise<void> {
    await this.#producer.disconnect();
  }
}
