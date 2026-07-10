// ══════════════════════════════════════════════════════════════════
// notification-service — DeliverInvitation use case
//
// On each SLOT_ASSIGNED: resolve a deliverable contact, render the invitation,
// hand it to the channel, and emit NOTIFICATION_DELIVERED (the PII-free
// outcome) + AUDIT_ENTRY. application-service consumes NOTIFICATION_DELIVERED
// and advances SLOT_ASSIGNED → PHYSICAL_TEST_SCHEDULED (single-writer, ADR-006).
//
// Delivery status and lifecycle progress are DECOUPLED: the schedule is active
// the moment a slot exists, so a missing contact (PENDING_NO_CONTACT) or a
// channel failure (FAILED) still advances the lifecycle; only the recorded
// delivery status differs. Infra faults (event publish) propagate so the
// consumer offset is not committed and the event is redelivered.
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { Agency, AuditEvent, NotificationDeliveredEvent } from '@usrp/shared-types';
import type { ContactResolver } from '../ports/contact-resolver.js';
import type { NotificationChannel } from '../ports/notification-channel.js';
import { buildInvitationBody, type SlotInvitationContent } from '../domain/notification.js';

/** The PII-free slot facts needed to deliver an invitation. */
export interface DeliverInvitationCommand {
  readonly applicantId: string;
  readonly applicationId: string;
  readonly agency: Agency;
  readonly content: SlotInvitationContent;
  readonly context: EventContext;
}

export type DeliveryStatus = 'DELIVERED' | 'PENDING_NO_CONTACT' | 'FAILED';

export interface DeliverInvitationOutcome {
  readonly deliveryStatus: DeliveryStatus;
  readonly channel: 'SMS' | 'EMAIL';
}

export interface DeliverInvitationDeps {
  readonly resolver: ContactResolver;
  readonly channel: NotificationChannel;
  readonly eventBus: EventBus;
}

export class DeliverInvitationService {
  constructor(private readonly deps: DeliverInvitationDeps) {}

  async deliver(command: DeliverInvitationCommand): Promise<DeliverInvitationOutcome> {
    const contact = await this.deps.resolver.resolve(command.applicantId);

    let deliveryStatus: DeliveryStatus;
    let channel: 'SMS' | 'EMAIL';
    if (contact === null) {
      deliveryStatus = 'PENDING_NO_CONTACT';
      channel = 'SMS'; // intended primary channel; nothing was sent
    } else {
      channel = contact.channel;
      const outcome = await this.deps.channel.send({
        channel: contact.channel,
        destination: contact.destination,
        body: buildInvitationBody(command.content),
      });
      deliveryStatus = outcome === 'DELIVERED' ? 'DELIVERED' : 'FAILED';
    }

    const delivered: NotificationDeliveredEvent = {
      ...newEnvelope(command.context),
      eventType: 'NOTIFICATION_DELIVERED',
      applicantId: command.applicantId,
      applicationId: command.applicationId,
      agency: command.agency,
      notificationType: 'SLOT_INVITATION',
      channel,
      deliveryStatus,
    };
    await this.deps.eventBus.publish(delivered);

    const audit: AuditEvent = {
      ...newEnvelope(command.context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICATION',
      entityId: command.applicationId,
      action: 'SLOT_INVITATION_NOTIFIED',
      performedBy: 'notification-service',
      agency: command.agency,
      metadata: { channel, deliveryStatus, notificationType: 'SLOT_INVITATION' },
    };
    await this.deps.eventBus.publish(audit);

    return { deliveryStatus, channel };
  }
}
