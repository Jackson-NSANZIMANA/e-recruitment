// ══════════════════════════════════════════════════════════════════
// @usrp/shared-events — Kafka transport (the ONLY file importing kafkajs)
//
// ADR-001: Apache Kafka (KRaft). This is the production EventBus. All
// other modules in this package are transport-agnostic; swapping brokers
// or client library touches only this file.
//
// EVERY BLOCKING STARTUP CALL HERE IS BOUNDED (see ./startup.ts). kafkajs
// retries broker discovery indefinitely by design — correct for a running
// service, fatal for a booting one, because the process then never reaches
// server.listen() and reports itself neither healthy nor failed. Bounding it
// here rather than in each service means no service can forget to.
// ══════════════════════════════════════════════════════════════════

import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import type { KafkaTopic, USRPEvent } from '@usrp/shared-types';
import { partitionKeyForEvent, topicForEvent } from './topics.js';
import { JsonEventSerializer, type EventSerializer } from './serialization.js';
import { withStartupTimeout } from './startup.js';
import type { EventBus, EventHandler, EventMeta } from './bus.js';

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

    try {
      await withStartupTimeout(this.producer.connect(), 'connecting the Kafka producer');
      this.producerConnected = true;
    } catch (error) {
      // Promise.race abandons the losing promise, it does not cancel it. Tear
      // the client down so a connection that lands AFTER we gave up cannot
      // keep the event loop — and therefore a half-booted process — alive.
      await this.producer.disconnect().catch(() => undefined);
      throw error;
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

    // Registered ONLY once every step below has succeeded. A consumer pushed
    // onto this.consumers before it is running would be disconnected on
    // shutdown as though it were live — the failure path is the one that must
    // leave no residue.
    try {
      await withStartupTimeout(consumer.connect(), `connecting consumer group '${groupId}'`);
      await withStartupTimeout(
        consumer.subscribe({ topics: [...topics], fromBeginning: false }),
        `subscribing consumer group '${groupId}' to ${topics.join(', ')}`,
      );

      // consumer.run() RESOLVES once the consumer loop is started; it does not
      // wait for a rebalance to settle, so it is not the step that hangs.
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

      this.consumers.push(consumer);
    } catch (error) {
      await consumer.disconnect().catch(() => undefined);
      throw error;
    }
  }
}
