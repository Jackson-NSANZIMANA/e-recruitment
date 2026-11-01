// ══════════════════════════════════════════════════════════════════
// @usrp/shared-events — Raw message republishing (D2, ADR-050 §3.4)
//
// A re-drive is BYTE-EXACT: the original key and the original value go back to
// the original topic, with one provenance header. It is deliberately NOT an
// EventBus publish — that would decode an envelope, re-serialize it, and lose
// exactly the bytes the dead-letter record is evidence of (and an UNDECODABLE
// letter could not be re-driven at all, which the operator path already proves
// matters).
//
// The EventBus interface stays the contract for services. This port exists for
// the one component whose job is to move opaque bytes.
// ══════════════════════════════════════════════════════════════════

import { Kafka, logLevel, type Producer } from 'kafkajs';
import { REPLAYED_HEADER } from './redrive.js';

export interface RawMessage {
  readonly topic: string;
  readonly key: Buffer | null;
  readonly value: Buffer;
  /** Extra headers merged over the provenance header. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RawMessagePublisher {
  /** Publish opaque bytes. Rejects on any transport failure — the caller decides. */
  publishBatch(messages: readonly RawMessage[]): Promise<void>;
  disconnect(): Promise<void>;
}

/** Kafka-backed publisher. Auto-create is off: a missing parked topic is an error. */
export class KafkaRawPublisher implements RawMessagePublisher {
  readonly #producer: Producer;
  #connected = false;

  constructor(options: { readonly brokers: readonly string[]; readonly clientId: string; readonly ssl?: boolean }) {
    this.#producer = new Kafka({
      clientId: options.clientId,
      brokers: [...options.brokers],
      ssl: options.ssl ?? false,
      logLevel: logLevel.ERROR,
    }).producer({ allowAutoTopicCreation: false });
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    await this.#producer.connect();
    this.#connected = true;
  }

  async publishBatch(messages: readonly RawMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const byTopic = new Map<string, RawMessage[]>();
    for (const message of messages) {
      const bucket = byTopic.get(message.topic) ?? [];
      bucket.push(message);
      byTopic.set(message.topic, bucket);
    }
    await this.#producer.sendBatch({
      topicMessages: [...byTopic].map(([topic, bucket]) => ({
        topic,
        messages: bucket.map((m) => ({
          key: m.key,
          value: m.value,
          headers: { ...m.headers, [REPLAYED_HEADER]: 'true' },
        })),
      })),
    });
  }

  async disconnect(): Promise<void> {
    if (!this.#connected) return;
    await this.#producer.disconnect();
    this.#connected = false;
  }
}
