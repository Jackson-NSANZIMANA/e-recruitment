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
//
// EVERY CONSUMED MESSAGE HAS AN ERROR BOUNDARY (see ./dead-letter.ts, ADR-025).
// Before it, any throw inside eachMessage made kafkajs redeliver the same
// offset forever, so one poison message silently froze its whole partition.
// Now a message is HANDLED, or RETRIED with backoff, or DEAD-LETTERED — and if
// dead-lettering fails we rethrow so it is redelivered. Never dropped.
// ══════════════════════════════════════════════════════════════════

import { Kafka, logLevel, type Consumer, type IHeaders, type Producer } from 'kafkajs';
import type { KafkaTopic, USRPEvent } from '@usrp/shared-types';
import { partitionKeyForEvent, topicForEvent } from './topics.js';
import { JsonEventSerializer, type EventSerializer } from './serialization.js';
import { withStartupTimeout } from './startup.js';
import {
  DLQ_HEADERS,
  NonRetryableEventError,
  backoffMs,
  describeError,
  resolveDeadLetterPolicy,
  type DeadLetterPolicy,
  type DeadLetterReason,
} from './dead-letter.js';
import type { EventBus, EventHandler, EventMeta } from './bus.js';

export interface KafkaBusOptions {
  readonly brokers: readonly string[];
  readonly clientId: string;
  readonly ssl?: boolean;
  /** Serializer to use on the wire. Defaults to JSON (ADR-001 addendum). */
  readonly serializer?: EventSerializer;
  /** Retry + dead-letter policy for consumed messages. Defaults are the contract. */
  readonly deadLetter?: Partial<DeadLetterPolicy>;
}

/**
 * kafkajs' default heartbeatInterval. Retry sleeps are sliced to it so a
 * consumer backing off between attempts still heartbeats and is not evicted
 * from its group mid-retry (which would hand the message to another member
 * and run the same retries twice).
 */
const HEARTBEAT_SLICE_MS = 3_000;

/** Where a consumed message came from — everything a dead letter must record. */
interface ConsumedSource {
  readonly groupId: string;
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly key: Buffer | null;
  readonly value: Buffer;
}

type Decoded =
  | { readonly ok: true; readonly event: USRPEvent }
  | { readonly ok: false; readonly error: unknown };

export class KafkaEventBus implements EventBus {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly consumers: Consumer[] = [];
  private readonly serializer: EventSerializer;
  private readonly deadLetterPolicy: DeadLetterPolicy;
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
    this.deadLetterPolicy = resolveDeadLetterPolicy(options.deadLetter ?? {});
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
        eachMessage: async ({ topic, partition, message, heartbeat }): Promise<void> => {
          if (message.value === null) return;
          const source: ConsumedSource = {
            groupId,
            topic,
            partition,
            offset: message.offset,
            key: message.key,
            value: message.value,
          };

          // 1. Decode. Bytes that are not a USRP event can never succeed, so
          //    retrying them only extends the outage. Park them now.
          const decoded = this.decode(message.value);
          if (!decoded.ok) {
            await this.deadLetter(source, 'UNDECODABLE', 0, decoded.error, null);
            return;
          }

          const meta: EventMeta = {
            topic: topic as KafkaTopic,
            key: message.key?.toString() ?? partitionKeyForEvent(decoded.event),
            partition,
            offset: message.offset,
          };

          // 2. Handle, with bounded retry. Returning commits the offset.
          await this.handleWithRetry(decoded.event, meta, handler, source, heartbeat);
        },
      });

      this.consumers.push(consumer);
    } catch (error) {
      await consumer.disconnect().catch(() => undefined);
      throw error;
    }
  }

  private decode(value: Buffer): Decoded {
    try {
      return { ok: true, event: this.serializer.deserialize(value) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  private async handleWithRetry(
    event: USRPEvent,
    meta: EventMeta,
    handler: EventHandler,
    source: ConsumedSource,
    heartbeat: () => Promise<void>,
  ): Promise<void> {
    const policy = this.deadLetterPolicy;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await handler(event, meta);
        return;
      } catch (error) {
        if (error instanceof NonRetryableEventError) {
          await this.deadLetter(source, 'NON_RETRYABLE', attempt, error, event.eventId);
          return;
        }
        if (attempt >= policy.maxHandlerAttempts) {
          await this.deadLetter(source, 'HANDLER_FAILED', attempt, error, event.eventId);
          return;
        }
        const delayMs = backoffMs(policy, attempt);
        console.warn(
          JSON.stringify({
            msg: 'event_handler_retry',
            groupId: source.groupId,
            topic: source.topic,
            partition: source.partition,
            offset: source.offset,
            eventId: event.eventId,
            eventType: event.eventType,
            attempt,
            maxAttempts: policy.maxHandlerAttempts,
            nextDelayMs: delayMs,
            error: describeError(error),
          }),
        );
        // A heartbeat that throws (rebalance in progress) propagates: kafkajs
        // then hands the partition over and the message is redelivered to the
        // new owner. That is correct; finishing retries for a partition we no
        // longer own would race the new owner.
        await sleepWithHeartbeat(delayMs, heartbeat);
      }
    }
  }

  /**
   * Park a message on the dead-letter topic with the ORIGINAL key and bytes,
   * so a replay is byte-exact and lands on the same partition. Throws if the
   * write fails — the caller lets that propagate so kafkajs redelivers.
   */
  private async deadLetter(
    source: ConsumedSource,
    reason: DeadLetterReason,
    attempts: number,
    error: unknown,
    eventId: string | null,
  ): Promise<void> {
    const errorText = describeError(error);
    const headers: IHeaders = {
      [DLQ_HEADERS.REASON]: reason,
      [DLQ_HEADERS.GROUP]: source.groupId,
      [DLQ_HEADERS.SOURCE_TOPIC]: source.topic,
      [DLQ_HEADERS.SOURCE_PARTITION]: String(source.partition),
      [DLQ_HEADERS.SOURCE_OFFSET]: source.offset,
      [DLQ_HEADERS.ATTEMPTS]: String(attempts),
      [DLQ_HEADERS.ERROR]: errorText,
      [DLQ_HEADERS.DEAD_LETTERED_AT]: new Date().toISOString(),
      ...(eventId === null ? {} : { [DLQ_HEADERS.EVENT_ID]: eventId }),
    };

    await this.connect();
    await this.producer.send({
      topic: this.deadLetterPolicy.topic,
      messages: [{ key: source.key, value: source.value, headers }],
    });

    console.error(
      JSON.stringify({
        msg: 'event_dead_lettered',
        reason,
        groupId: source.groupId,
        topic: source.topic,
        partition: source.partition,
        offset: source.offset,
        attempts,
        eventId,
        deadLetterTopic: this.deadLetterPolicy.topic,
        error: errorText,
      }),
    );
  }
}

/** Sleep `ms`, heartbeating every slice so the group keeps this member. */
async function sleepWithHeartbeat(ms: number, heartbeat: () => Promise<void>): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    const step = Math.min(remaining, HEARTBEAT_SLICE_MS);
    await new Promise<void>((resolve) => setTimeout(resolve, step));
    remaining -= step;
    await heartbeat();
  }
}
