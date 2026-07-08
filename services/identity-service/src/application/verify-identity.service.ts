// ══════════════════════════════════════════════════════════════════
// identity-service — Verify & create applicant identity (use case)
//
// The NIDA-anchored spine of the whole platform: turn a raw National ID
// into a verified, PII-encrypted applicant_identities row and announce it
// on the event bus. Business outcomes (not found, non-citizen, already
// exists) are RETURN VALUES; only malformed input and infrastructure
// faults throw. The raw NID never appears in an event, a log, or a
// return value — only its hashes and the resulting applicant id do.
// ══════════════════════════════════════════════════════════════════

import { hashNationalId } from '@usrp/shared-security';
import { newCorrelationContext, newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { AuditEvent, NIDAVerificationCompletedEvent } from '@usrp/shared-types';
import type { ApplicationChannel } from '@usrp/shared-database';
import type { NidaGateway } from '../ports/nida.gateway.js';
import type { IdentityRepository } from '../ports/identity.repository.js';
import { RWANDAN_CITIZEN } from '../domain/nida.types.js';

export interface VerifyIdentityCommand {
  readonly rawNationalId: string;
  readonly registrationChannel: ApplicationChannel;
  /** Inbound correlation context to continue an existing trace; a fresh
   * chain is started when omitted. */
  readonly context?: EventContext;
}

export type VerifyIdentityOutcome =
  | {
      readonly kind: 'CREATED';
      readonly applicantId: string;
      readonly nationalIdHash: string;
      readonly event: NIDAVerificationCompletedEvent;
    }
  | {
      readonly kind: 'ALREADY_EXISTS';
      readonly applicantId: string;
      readonly nationalIdHash: string;
    }
  | {
      readonly kind: 'NOT_FOUND_IN_NIDA';
      readonly nationalIdHash: string;
      readonly event: AuditEvent;
    }
  | {
      readonly kind: 'NOT_A_CITIZEN';
      readonly nationalIdHash: string;
      readonly event: AuditEvent;
    };

export interface VerifyIdentityDeps {
  readonly nida: NidaGateway;
  readonly repository: IdentityRepository;
  readonly eventBus: EventBus;
  /** USRP-private key deriving the internal, system-wide nationalIdHash. */
  readonly nationalIdHmacKey: string;
}

export class VerifyIdentityService {
  constructor(private readonly deps: VerifyIdentityDeps) {}

  async verify(command: VerifyIdentityCommand): Promise<VerifyIdentityOutcome> {
    // Internal applicant key (distinct from the NIDA lookup hash). Throws
    // InvalidNationalIdError on a malformed NID — before any I/O.
    const nationalIdHash = hashNationalId(command.rawNationalId, this.deps.nationalIdHmacKey);

    // Cheap idempotency guard — avoid a G2G call for a known applicant.
    const existingId = await this.deps.repository.findIdByNationalIdHash(nationalIdHash);
    if (existingId !== null) {
      return { kind: 'ALREADY_EXISTS', applicantId: existingId, nationalIdHash };
    }

    const lookup = await this.deps.nida.lookupCitizen(command.rawNationalId);
    const context = command.context ?? newCorrelationContext();

    if (lookup.status === 'NOT_FOUND') {
      const event = this.buildFailureAudit(nationalIdHash, lookup.nidaRequestId, 'NIDA_CITIZEN_NOT_FOUND', context);
      await this.deps.eventBus.publish(event);
      return { kind: 'NOT_FOUND_IN_NIDA', nationalIdHash, event };
    }

    if (lookup.citizen.citizenshipStatus !== RWANDAN_CITIZEN) {
      const event = this.buildFailureAudit(nationalIdHash, lookup.nidaRequestId, 'NIDA_NON_CITIZEN', context);
      await this.deps.eventBus.publish(event);
      return { kind: 'NOT_A_CITIZEN', nationalIdHash, event };
    }

    const { applicantId, created } = await this.deps.repository.createVerifiedIdentity({
      nationalIdHash,
      nidaLookupHash: lookup.nidaLookupHash,
      fullName: lookup.citizen.fullName,
      dateOfBirth: lookup.citizen.dateOfBirth,
      homeDistrict: lookup.citizen.homeDistrict,
      homeProvince: lookup.citizen.homeProvince,
      gender: lookup.citizen.gender,
      registrationChannel: command.registrationChannel,
      phoneNumberHash: null, // phone verification is a later OTP step
      nidaVerificationRequestId: lookup.nidaRequestId,
      nidaMatchConfidence: lookup.matchConfidence,
    });

    if (!created) {
      // A concurrent request won the insert race between our guard and here.
      return { kind: 'ALREADY_EXISTS', applicantId, nationalIdHash };
    }

    const event: NIDAVerificationCompletedEvent = {
      ...newEnvelope(context),
      eventType: 'NIDA_VERIFICATION_COMPLETED',
      applicantId,
      nidaRequestId: lookup.nidaRequestId,
      verified: true,
      matchConfidence: lookup.matchConfidence,
      homeDistrict: lookup.citizen.homeDistrict,
      homeProvince: lookup.citizen.homeProvince,
    };
    await this.deps.eventBus.publish(event);

    return { kind: 'CREATED', applicantId, nationalIdHash, event };
  }

  /** A failed verification is recorded as an immutable audit event; there
   * is no applicant row, so the audit subject is the nationalIdHash. */
  private buildFailureAudit(
    nationalIdHash: string,
    nidaRequestId: string,
    action: 'NIDA_CITIZEN_NOT_FOUND' | 'NIDA_NON_CITIZEN',
    context: EventContext,
  ): AuditEvent {
    return {
      ...newEnvelope(context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICANT',
      entityId: nationalIdHash,
      action,
      performedBy: 'identity-service',
      agency: 'SYSTEM',
      metadata: { nidaRequestId },
    };
  }
}
