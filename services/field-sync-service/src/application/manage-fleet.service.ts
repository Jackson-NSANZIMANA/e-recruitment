// ══════════════════════════════════════════════════════════════════
// field-sync-service — Device fleet management (S09, ADR-036 addendum)
//
// List, assign to a venue day, and revoke field devices. All three need
// `field.device.manage` (field_supervisor, agency_admin) — checked at the
// controller. The agency is the principal's, never the body's.
//
// A revocation takes effect on the device's NEXT contact: the score sync and
// B1's biometric evidence both read revoked_at on every record, and a revoked id
// can never be enrolled again. The audit entry is staged in the transactional
// outbox in the SAME transaction as the state change (a crash cannot leave a
// revocation without its audit), then dispatched post-commit; the relay is the
// delivery guarantee.
//
// OFFLINE EXPOSURE WINDOW: a revoked device that never reconnects keeps its
// local data and its enrolled key until it is wiped (S15, operations runbook).
// Revocation stops the server trusting it; it does not reach into the device.
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventContext } from '@usrp/shared-events';
import type { Agency, AuditEvent, USRPEvent } from '@usrp/shared-types';
import type { PgOutboxDispatcher } from '@usrp/shared-database';
import type {
  AssignOutcome,
  DeviceRegistry,
  FleetDevice,
  RevokeOutcome,
  RevokeReason,
} from '../ports/device-registry.js';

export interface FleetActor {
  readonly agency: Agency;
  readonly subjectId: string;
  /** The officer's database role, for the engine-scoped list. */
  readonly dbRole: string;
}

export interface ManageFleetDeps {
  readonly registry: DeviceRegistry;
  readonly dispatcher: PgOutboxDispatcher<USRPEvent>;
}

export class ManageFleetService {
  constructor(private readonly deps: ManageFleetDeps) {}

  list(actor: FleetActor): Promise<readonly FleetDevice[]> {
    return this.deps.registry.list({ agency: actor.agency, dbRole: actor.dbRole });
  }

  async revoke(
    actor: FleetActor,
    command: { readonly deviceId: string; readonly reason: RevokeReason; readonly context: EventContext },
  ): Promise<RevokeOutcome> {
    const audit = this.audit(actor, command.context, command.deviceId, 'FIELD_DEVICE_REVOKED', {
      deviceId: command.deviceId,
      reason: command.reason,
    });
    const outcome = await this.deps.registry.revoke({
      deviceId: command.deviceId,
      agency: actor.agency,
      revokedBy: actor.subjectId,
      reason: command.reason,
      audit,
    });
    if (outcome.kind === 'REVOKED') await this.deps.dispatcher.dispatch([audit]);
    return outcome;
  }

  async assign(
    actor: FleetActor,
    command: {
      readonly deviceId: string;
      readonly campaignPublicCode: string;
      readonly district: string;
      readonly examDate: string;
      readonly context: EventContext;
    },
  ): Promise<AssignOutcome> {
    const audit = this.audit(actor, command.context, command.deviceId, 'FIELD_DEVICE_ASSIGNED', {
      deviceId: command.deviceId,
      campaign: command.campaignPublicCode,
      district: command.district,
      examDate: command.examDate,
    });
    const outcome = await this.deps.registry.assign({
      deviceId: command.deviceId,
      agency: actor.agency,
      campaignPublicCode: command.campaignPublicCode,
      district: command.district,
      examDate: command.examDate,
      assignedBy: actor.subjectId,
      audit,
    });
    if (outcome.kind === 'ASSIGNED') await this.deps.dispatcher.dispatch([audit]);
    return outcome;
  }

  private audit(
    actor: FleetActor,
    context: EventContext,
    deviceId: string,
    action: string,
    metadata: Record<string, unknown>,
  ): AuditEvent {
    return {
      ...newEnvelope(context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'SYSTEM',
      entityId: deviceId,
      action,
      performedBy: actor.subjectId,
      agency: actor.agency,
      metadata,
    };
  }
}
