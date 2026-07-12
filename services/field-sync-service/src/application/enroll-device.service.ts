// ══════════════════════════════════════════════════════════════════
// field-sync-service — EnrollDevice use case
//
// Registers a field tablet's Ed25519 PUBLIC key under the enrolling officer's
// agency (from their verified token — never the body). The device can then sign
// score records that this service will trust. Enrollment is idempotent; a
// genuine first enrollment emits an AUDIT_ENTRY (a security-relevant act — a new
// signing key becomes trusted). The private key never leaves the tablet.
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { Agency, AuditEvent } from '@usrp/shared-types';
import type { DeviceRegistry, EnrollOutcome } from '../ports/device-registry.js';

export interface EnrollDeviceCommand {
  readonly deviceId: string;
  readonly publicKeyPem: string;
  readonly agency: Agency;
  readonly enrolledBy: string;
  readonly context: EventContext;
}

export interface EnrollDeviceDeps {
  readonly registry: DeviceRegistry;
  readonly eventBus: EventBus;
}

export class EnrollDeviceService {
  constructor(private readonly deps: EnrollDeviceDeps) {}

  async enroll(command: EnrollDeviceCommand): Promise<EnrollOutcome> {
    const outcome = await this.deps.registry.enroll({
      deviceId: command.deviceId,
      publicKeyPem: command.publicKeyPem,
      agency: command.agency,
      enrolledBy: command.enrolledBy,
    });

    // Only a genuine first enrollment is auditable; a repeat is a silent no-op.
    if (outcome.kind === 'ENROLLED') {
      const audit: AuditEvent = {
        ...newEnvelope(command.context),
        eventType: 'AUDIT_ENTRY',
        entityType: 'SYSTEM',
        entityId: command.deviceId,
        action: 'FIELD_DEVICE_ENROLLED',
        performedBy: command.enrolledBy,
        agency: command.agency,
        metadata: { deviceId: command.deviceId },
      };
      await this.deps.eventBus.publish(audit);
    }

    return outcome;
  }
}
