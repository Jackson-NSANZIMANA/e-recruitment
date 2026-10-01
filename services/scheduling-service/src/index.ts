// ══════════════════════════════════════════════════════════════════
// @usrp/scheduling-service — Public API & composition root
//
// Wires the slot-assignment use case (home-district reader + venue reader +
// slot ledger) to the caller-provided event bus through the outbox fast path.
// Tests inject an InMemoryEventBus; production injects a KafkaEventBus (see
// main.ts). The service exposes no HTTP business surface — its whole behaviour
// is "consume application.cleared → reserve a seat → announce".
//
// OUTBOX (ADR-025 / ADR-026): SLOT_ASSIGNED and its audit are staged in the
// reservation transaction and dispatched over the bus after commit. The relay
// that guarantees delivery is started by main.ts (createSchedulingOutboxRelay),
// not here, so composing the service in a proof starts no timers.
// ══════════════════════════════════════════════════════════════════

import { PgOutboxDispatcher, PgOutboxRelay, type OutboxRelayOptions } from '@usrp/shared-database';
import { hasValidEnvelope, type EventBus } from '@usrp/shared-events';
import type { USRPEvent } from '@usrp/shared-types';
import { signSlotInvitation } from '@usrp/shared-security';
import { PgHomeDistrictReader } from './adapters/identity.pg-reader.js';
import { PgVenueReader } from './adapters/venue.pg-reader.js';
import { PgSlotLedger, SCHEDULING_OUTBOX_PRODUCER } from './adapters/slot-ledger.pg-repository.js';
import { AssignSlotService, type SlotInvitationSigner } from './application/assign-slot.service.js';
import type { SchedulingServiceConfig } from './config.js';

export interface SchedulingService {
  readonly assignSlot: AssignSlotService;
}

/** Assemble the slot-assignment use case from config + event transport. */
export function createSchedulingService(
  config: SchedulingServiceConfig,
  eventBus: EventBus,
): SchedulingService {
  const districtReader = new PgHomeDistrictReader(config.security.encryptionKey);
  const venueReader = new PgVenueReader();
  const ledger = new PgSlotLedger();
  const events = new PgOutboxDispatcher<USRPEvent>(eventBus, SCHEDULING_OUTBOX_PRODUCER);
  const invitationSigner: SlotInvitationSigner = {
    keyId: config.signing.qrSigningKeyId,
    sign: (claims) => signSlotInvitation(config.signing.qrSigningPrivateKeyPem, claims),
  };
  return {
    assignSlot: new AssignSlotService({ districtReader, venueReader, ledger, events, invitationSigner }),
  };
}

/** Tunables a proof or operator may override; producer + guard are fixed. */
export type SchedulingOutboxRelayOptions = Omit<OutboxRelayOptions, 'producer' | 'isValid'>;

/** The relay that guarantees this service's staged events reach the bus. */
export function createSchedulingOutboxRelay(
  eventBus: EventBus,
  options: SchedulingOutboxRelayOptions = {},
): PgOutboxRelay<USRPEvent> {
  return new PgOutboxRelay<USRPEvent>(eventBus, {
    ...options,
    producer: SCHEDULING_OUTBOX_PRODUCER,
    isValid: (payload: unknown): boolean => hasValidEnvelope(payload),
  });
}

// ── Re-exports ─────────────────────────────────────────────────────
export { AssignSlotService } from './application/assign-slot.service.js';
export type {
  AssignSlotCommand,
  AssignSlotDeps,
  AssignSlotOutcome,
  SlotInvitationSigner,
} from './application/assign-slot.service.js';
export {
  SCHEDULING_CONSUMER_GROUP,
  startApplicationClearedConsumer,
} from './adapters/events/application-cleared.consumer.js';
export { PgHomeDistrictReader } from './adapters/identity.pg-reader.js';
export { PgVenueReader } from './adapters/venue.pg-reader.js';
export { PgSlotLedger, SCHEDULING_OUTBOX_PRODUCER } from './adapters/slot-ledger.pg-repository.js';
export { SchedulingReadError, SchedulingWriteError } from './domain/scheduling.errors.js';
export type { HomeDistrictReader, VenueReader, VenueAssignment } from './ports/readers.js';
export type {
  EventDispatcher,
  NoCapacityReason,
  ReserveSlotInput,
  ReserveSlotOutcome,
  SlotLedger,
  StageEvents,
} from './ports/slot-ledger.js';
export { loadSchedulingConfig } from './config.js';
export type {
  SchedulingServiceConfig,
  SchedulingSecurityConfig,
  SchedulingSigningConfig,
} from './config.js';
