// ══════════════════════════════════════════════════════════════════
// @usrp/notification-service — Public API & composition root
//
// Wires the delivery use case to its adapters (contact resolver + channel).
// The caller supplies the EventBus (InMemory in tests, Kafka in prod). Today
// the production contact resolver has no deliverable contact on file, so
// delivery is recorded PENDING_NO_CONTACT and the lifecycle still advances
// (see NoStoredContactResolver). Swap that adapter when contact capture lands.
// ══════════════════════════════════════════════════════════════════

import type { EventBus } from '@usrp/shared-events';
import { LogSmsChannel } from '@usrp/shared-sms';
import { DeliverInvitationService } from './application/deliver-invitation.service.js';
import { NoStoredContactResolver } from './adapters/no-stored-contact.resolver.js';
import type { NotificationServiceConfig } from './config.js';

export interface NotificationService {
  readonly deliver: DeliverInvitationService;
}

export function createNotificationService(
  _config: NotificationServiceConfig,
  eventBus: EventBus,
): NotificationService {
  return {
    deliver: new DeliverInvitationService({
      resolver: new NoStoredContactResolver(),
      channel: new LogSmsChannel(),
      eventBus,
    }),
  };
}

// ── Re-exports ────────────────────────────────────────────────────
export { DeliverInvitationService } from './application/deliver-invitation.service.js';
export type {
  DeliverInvitationCommand,
  DeliverInvitationDeps,
  DeliverInvitationOutcome,
  DeliveryStatus,
} from './application/deliver-invitation.service.js';
export {
  NOTIFICATION_CONSUMER_GROUP,
  startSlotAssignedConsumer,
} from './adapters/events/slot-assigned.consumer.js';
export { NoStoredContactResolver } from './adapters/no-stored-contact.resolver.js';
export { LogSmsChannel } from '@usrp/shared-sms';
export type { OutboundSms, SmsChannel, SmsDeliveryOutcome } from '@usrp/shared-sms';
export { buildInvitationBody } from './domain/notification.js';
export type { SlotInvitationContent } from './domain/notification.js';
export { loadNotificationConfig } from './config.js';
export type { NotificationServiceConfig } from './config.js';
export type { ContactResolver, ResolvedContact } from './ports/contact-resolver.js';
