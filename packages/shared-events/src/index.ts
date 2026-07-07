// ══════════════════════════════════════════════════════════════════
// @usrp/shared-events — Public API
//
//   Build events:      newCorrelationContext, deriveContext, newEnvelope
//   Route:             topicForEvent, partitionKeyForEvent
//   Serialize:         JsonEventSerializer (EventSerializer interface)
//   Transport:         KafkaEventBus (prod) / InMemoryEventBus (tests)
//
// Services depend on the EventBus interface — never on kafkajs directly.
// ══════════════════════════════════════════════════════════════════

export {
  EVENT_VERSION,
  deriveContext,
  hasValidEnvelope,
  newCorrelationContext,
  newEnvelope,
  type EventContext,
  type EventEnvelope,
} from './envelope.js';

export { partitionKeyForEvent, topicForEvent } from './topics.js';

export {
  EventDeserializationError,
  JsonEventSerializer,
  type EventSerializer,
} from './serialization.js';

export {
  InMemoryEventBus,
  type EventBus,
  type EventHandler,
  type EventMeta,
} from './bus.js';

export { KafkaEventBus, type KafkaBusOptions } from './kafka-bus.js';
