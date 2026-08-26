// ══════════════════════════════════════════════════════════════════
// @usrp/shared-events — Kafka transport (the ONLY file importing kafkajs)
//
// ADR-001: Apache Kafka (KRaft). This is the production EventBus. All
// other modules in this package are transport-agnostic; swapping brokers
// or client library touches only this file.
// ══════════════════════════════════════════════════════════════════

import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import type { KafkaTopic, USRPEvent } from '@usrp/shared-types';
import { partitionKeyForEvent, topicForEvent } from './topics.js';
import { JsonEventSerializer, type EventSerializer } from './serialization.js';
import type { EventBus, EventHandler, EventMeta } from './bus.js';

const KAFKA_STARTUP_TIMEOUT_MS = 30_000;

export interface KafkaBusOptions {
  readonly brokers: readonly string[];
  readonly clientId: string;
  readonly ssl?: boolean;
  /** Serializer to use on the wire. Defaults to JSON (ADR-001 addendum). */
  readonly serializer?: EventSerializer;
}

export class KafkaEventBus implements EventBus {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly consumers: Consumer[] = [];
  private readonly serializer: EventSerializer;
  private producerConnected = false;

  constructor(options: KafkaBusOptions) {
    this.kafka = new Kafka({
      clientId: options.clientId,
      brokers: [...options.brokers],
      ssl: options.ssl ?? false,
      logLevel: logLevel.ERROR,
    });
    this.producer = this.kafka.producer({ allowAutoTopicCreation: false });
    this.serializer = options.serializer ?? new JsonEventSerializer();
  }

  async connect(): Promise<void> {
    if (this.producerConnected) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.producer.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Kafka startup timed out while connecting producer after ${KAFKA_STARTUP_TIMEOUT_MS}ms`,
              ),
            );
          }, KAFKA_STARTUP_TIMEOUT_MS);
        }),
      ]);
      this.producerConnected = true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async disconnect(): Promise<void> {
    await Promise.all(this.consumers.map((c) => c.disconnect()));
    this.consumers.length = 0;
    if (this.producerConnected) {
      await this.producer.disconnect();
      this.producerConnected = false;
    }
  }

  async publish(event: USRPEvent): Promise<void> {
    await this.connect();
    await this.producer.send({
      topic: topicForEvent(event),
      messages: [{ key: partitionKeyForEvent(event), value: this.serializer.serialize(event) }],
    });
  }

  async subscribe(
    topics: readonly KafkaTopic[],
    groupId: string,
    handler: EventHandler,
  ): Promise<void> {
    const consumer = this.kafka.consumer({ groupId });
    await consumer.connect();
    await consumer.subscribe({ topics: [...topics], fromBeginning: false });
    this.consumers.push(consumer);

    await consumer.run({
      eachMessage: async ({ topic, partition, message }): Promise<void> => {
        if (message.value === null) return;
        const event = this.serializer.deserialize(message.value);
        const meta: EventMeta = {
          topic: topic as KafkaTopic,
          key: message.key?.toString() ?? partitionKeyForEvent(event),
          partition,
          offset: message.offset,
        };
        await handler(event, meta);
      },
    });
  }
}
