// ══════════════════════════════════════════════════════════════════
// @usrp/shared-events — Public API
//
//   Build events:      newCorrelationContext, deriveContext, newEnvelope
//   Route:             topicForEvent, partitionKeyForEvent
//   Serialize:         JsonEventSerializer (EventSerializer interface)
//   Transport:         KafkaEventBus (prod) / InMemoryEventBus (tests)
//   Bootstrap:         withStartupTimeout, logStartupPhase
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

// Bootstrap: the bound and the phase marker every service main() shares.
export {
  DEFAULT_STARTUP_TIMEOUT_MS,
  StartupTimeoutError,
  logStartupPhase,
  withStartupTimeout,
} from './startup.js';
