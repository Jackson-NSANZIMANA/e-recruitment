// ══════════════════════════════════════════════════════════════════
// notification-service — DeliverWithdrawalNotice use case (ADR-022)
//
// On each APPLICATION_WITHDRAWN summary: resolve the stored contact
// (ADR-021), render the one-per-citizen notice (owner D14b), send, and
// record the outcome as an AUDIT_ENTRY. Deliberately NO
// NOTIFICATION_DELIVERED event: that event exists to advance application
// state (SLOT_ASSIGNED → PHYSICAL_TEST_SCHEDULED) and a withdrawal notice
// must never touch the lifecycle — the audit trail is the durable record
// here. Infra faults propagate → offset uncommitted → redelivery; the
// producer emits the summary only on a genuine sweep, so redelivery of
// the ACCEPTANCE cannot re-send (redelivery of the summary itself can —
// the known ADR-021 retry-tier limitation, acceptable on LogChannel).
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { SmsChannel } from '@usrp/shared-sms';
import type { Agency, AuditEvent, WithdrawnApplicationRef } from '@usrp/shared-types';
import type { ContactResolver } from '../ports/contact-resolver.js';
import { buildWithdrawalNoticeBody } from '../domain/notification.js';
import type { DeliveryStatus } from './deliver-invitation.service.js';

export interface DeliverWithdrawalNoticeCommand {
  readonly applicantId: string;
  readonly acceptedApplicationId: string;
  readonly acceptedByAgency: Agency;
  readonly withdrawn: readonly WithdrawnApplicationRef[];
  readonly context: EventContext;
}

export interface DeliverWithdrawalNoticeDeps {
  readonly resolver: ContactResolver;
  readonly channel: SmsChannel;
  readonly eventBus: EventBus;
}

export class DeliverWithdrawalNoticeService {
  constructor(private readonly deps: DeliverWithdrawalNoticeDeps) {}

  async deliver(command: DeliverWithdrawalNoticeCommand): Promise<DeliveryStatus> {
    const contact = await this.deps.resolver.resolve(command.applicantId);

    let deliveryStatus: DeliveryStatus;
    if (contact === null) {
      deliveryStatus = 'PENDING_NO_CONTACT';
    } else {
      const outcome = await this.deps.channel.send({
        destination: contact.destination,
        body: buildWithdrawalNoticeBody({
          acceptedByAgency: command.acceptedByAgency,
          withdrawnAgencies: command.withdrawn.map((w) => w.agency),
        }),
      });
      deliveryStatus = outcome === 'ACCEPTED' ? 'DELIVERED' : 'FAILED';
    }

    const audit: AuditEvent = {
      ...newEnvelope(command.context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICANT',
      entityId: command.applicantId,
      action: 'WITHDRAWAL_NOTICE_NOTIFIED',
      performedBy: 'notification-service',
      agency: command.acceptedByAgency,
      metadata: {
        notificationType: 'WITHDRAWAL_NOTICE',
        channel: 'SMS',
        deliveryStatus,
        withdrawnCount: command.withdrawn.length,
        acceptedApplicationId: command.acceptedApplicationId,
      },
    };
    await this.deps.eventBus.publish(audit);

    return deliveryStatus;
  }
}
