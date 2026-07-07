// ══════════════════════════════════════════════════════════════════
// @usrp/shared-events — EventBus interface + in-memory implementation
//
// Services depend on the EventBus interface, never on kafkajs directly.
// InMemoryEventBus is a fully-functional, zero-dependency implementation
// used in unit/integration tests and local runs without a broker.
// ══════════════════════════════════════════════════════════════════

import type { KafkaTopic, USRPEvent } from '@usrp/shared-types';
import { partitionKeyForEvent, topicForEvent } from './topics.js';

export interface EventMeta {
  readonly topic: KafkaTopic;
  readonly key: string;
  readonly partition?: number;
  readonly offset?: string;
}

export type EventHandler = (event: USRPEvent, meta: EventMeta) => Promise<void> | void;

export interface EventBus {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  publish(event: USRPEvent): Promise<void>;
  /**
   * Subscribe a consumer group to one or more topics. The same groupId
   * across replicas forms one competing-consumer group (Kafka semantics).
   */
  subscribe(topics: readonly KafkaTopic[], groupId: string, handler: EventHandler): Promise<void>;
}

interface Subscription {
  readonly topics: ReadonlySet<KafkaTopic>;
  readonly handler: EventHandler;
}

/**
 * In-memory bus: publish synchronously fans out to every subscription
 * registered for the event's topic, awaiting each handler. Ordering is
 * preserved per publish call. Intended for tests and local development.
 */
export class InMemoryEventBus implements EventBus {
  private readonly subscriptions: Subscription[] = [];
  readonly published: USRPEvent[] = [];

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  async publish(event: USRPEvent): Promise<void> {
    this.published.push(event);
    const topic = topicForEvent(event);
    const meta: EventMeta = { topic, key: partitionKeyForEvent(event) };
    for (const sub of this.subscriptions) {
      if (sub.topics.has(topic)) {
        await sub.handler(event, meta);
      }
    }
  }

  subscribe(topics: readonly KafkaTopic[], _groupId: string, handler: EventHandler): Promise<void> {
    this.subscriptions.push({ topics: new Set(topics), handler });
    return Promise.resolve();
  }
}
