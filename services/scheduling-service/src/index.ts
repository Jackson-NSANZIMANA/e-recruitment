// ══════════════════════════════════════════════════════════════════
// @usrp/scheduling-service — Public API & composition root
//
// Wires the slot-assignment use case (home-district reader + venue reader) to
// the caller-provided event bus. Tests inject an InMemoryEventBus + fake
// readers; production injects a KafkaEventBus + the PostgreSQL adapters (see
// main.ts). The service exposes no HTTP business surface — its whole behaviour
// is "consume application.cleared → assign venue → emit" — so the root just
// assembles the use case the consumer drives.
// ══════════════════════════════════════════════════════════════════

import type { EventBus } from '@usrp/shared-events';
import { signSlotInvitation } from '@usrp/shared-security';
import { PgHomeDistrictReader } from './adapters/identity.pg-reader.js';
import { PgVenueReader } from './adapters/venue.pg-reader.js';
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
  const invitationSigner: SlotInvitationSigner = {
    keyId: config.signing.qrSigningKeyId,
    sign: (claims) => signSlotInvitation(config.signing.qrSigningPrivateKeyPem, claims),
  };
  return {
    assignSlot: new AssignSlotService({ districtReader, venueReader, eventBus, invitationSigner }),
  };
}

// ── Re-exports ────────────────────────────────────────────────────
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
export { SchedulingReadError } from './domain/scheduling.errors.js';
export type { HomeDistrictReader, VenueReader, VenueAssignment } from './ports/readers.js';
export { loadSchedulingConfig } from './config.js';
export type {
  SchedulingServiceConfig,
  SchedulingSecurityConfig,
  SchedulingSigningConfig,
} from './config.js';
