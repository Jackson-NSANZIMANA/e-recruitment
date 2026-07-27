// ══════════════════════════════════════════════════════════════════
// @usrp/notification-service — Public API & composition root
//
// Wires the delivery use case to its adapters. The caller supplies the
// EventBus (InMemory in tests, Kafka in prod) AND the adapters — the
// identity-service pattern — so main.ts wires the real PgContactResolver
// (decrypts the ADR-021 stored contact) + LogSmsChannel, while proofs
// inject statics. An applicant with no captured contact still resolves
// null → delivery records PENDING_NO_CONTACT and the lifecycle advances.
// ══════════════════════════════════════════════════════════════════

import type { EventBus } from '@usrp/shared-events';
import type { SmsChannel } from '@usrp/shared-sms';
import { DeliverInvitationService } from './application/deliver-invitation.service.js';
import type { ContactResolver } from './ports/contact-resolver.js';
import type { NotificationServiceConfig } from './config.js';

export interface NotificationService {
  readonly deliver: DeliverInvitationService;
}

export interface NotificationAdapters {
  readonly resolver: ContactResolver;
  readonly sms: SmsChannel;
}

export function createNotificationService(
  _config: NotificationServiceConfig,
  eventBus: EventBus,
  adapters: NotificationAdapters,
): NotificationService {
  return {
    deliver: new DeliverInvitationService({
      resolver: adapters.resolver,
      channel: adapters.sms,
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
export { PgContactResolver } from './adapters/contact.pg-resolver.js';
export { LogSmsChannel } from '@usrp/shared-sms';
export type { OutboundSms, SmsChannel, SmsDeliveryOutcome } from '@usrp/shared-sms';
export { buildInvitationBody } from './domain/notification.js';
export type { SlotInvitationContent } from './domain/notification.js';
export { loadNotificationConfig } from './config.js';
export type { NotificationServiceConfig } from './config.js';
export type { ContactResolver, ResolvedContact } from './ports/contact-resolver.js';
