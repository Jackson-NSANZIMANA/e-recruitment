// ══════════════════════════════════════════════════════════════════
// scheduling-service — Assign exam slot (use case)
//
// The scheduling gate. Triggered by APPLICATION_ELIGIBILITY_CLEARED (an
// application reached the positive eligibility terminal), it: reads + decrypts
// the applicant's home district, resolves the venue that district reports to for
// the campaign, mints an opaque QR invitation token, and emits SLOT_ASSIGNED
// (which application-service's projection stamps onto the row) plus an
// AUDIT_ENTRY of the decision.
//
// Business outcomes are RETURN VALUES:
//   • ASSIGNED       — venue resolved, SLOT_ASSIGNED emitted.
//   • NO_VENUE       — no venue seeded for this (campaign, district); e.g. RNP,
//                      whose venue list is not published. We emit an AUDIT_ENTRY
//                      (SLOT_ASSIGNMENT_DEFERRED) and NO SLOT_ASSIGNED, so the
//                      application holds at DOCUMENT_REVIEW_GREEN for manual
//                      handling — honest, never a fabricated venue.
//   • APPLICANT_NOT_FOUND — identity missing/erased.
// Only infrastructure faults (SchedulingReadError, publish failure) throw and
// propagate → offset uncommitted → redelivery.
//
// COMPLIANCE: the raw home district never appears in an event or a log — only
// the RESOLVED venue (a public location) does. The district is used solely to
// look the venue up.
// ══════════════════════════════════════════════════════════════════

import { randomBytes } from 'node:crypto';
import { newCorrelationContext, newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { Agency, AuditEvent, SlotAssignedEvent, SlotInvitationClaims } from '@usrp/shared-types';
import type { HomeDistrictReader, VenueReader } from '../ports/readers.js';

/**
 * Signs the verifiable slot-invitation credential (ADR-009). The private key
 * lives in the composition root, not the domain — the service only asks for a
 * token over a claim set it built. `keyId` is stamped into the claims so an
 * offline verifier can select the matching public key.
 */
export interface SlotInvitationSigner {
  readonly keyId: string;
  sign(claims: SlotInvitationClaims): string;
}

export interface AssignSlotCommand {
  readonly applicationId: string;
  readonly applicantId: string;
  readonly agency: Agency;
  readonly campaignId: string;
  /** Inbound correlation context; a fresh chain starts when omitted. */
  readonly context?: EventContext;
}

export type AssignSlotOutcome =
  | {
      readonly kind: 'ASSIGNED';
      readonly applicationId: string;
      readonly venueName: string;
      readonly examDate: string;
      readonly qrInvitationCode: string;
      readonly qrSignedToken: string;
      readonly event: SlotAssignedEvent;
    }
  | { readonly kind: 'NO_VENUE'; readonly applicationId: string }
  | { readonly kind: 'APPLICANT_NOT_FOUND'; readonly applicantId: string };

export interface AssignSlotDeps {
  readonly districtReader: HomeDistrictReader;
  readonly venueReader: VenueReader;
  readonly eventBus: EventBus;
  readonly invitationSigner: SlotInvitationSigner;
}

/**
 * Mint the stable, unique TICKET ID (32 bytes → 43 base64url chars, ≤64). This
 * is the DB unique key and the anchor physical-test scores bind to — NOT the QR
 * the applicant scans (that is the signed token built from it).
 */
function mintTicketId(): string {
  return randomBytes(32).toString('base64url');
}

export class AssignSlotService {
  constructor(private readonly deps: AssignSlotDeps) {}

  async assign(command: AssignSlotCommand): Promise<AssignSlotOutcome> {
    const district = await this.deps.districtReader.homeDistrictOf(command.applicantId);
    if (district === null) {
      return { kind: 'APPLICANT_NOT_FOUND', applicantId: command.applicantId };
    }

    const venue = await this.deps.venueReader.venueFor(command.campaignId, district);
    const context = command.context ?? newCorrelationContext();

    if (venue === null) {
      // No venue for this district/campaign — defer, don't fabricate. Audit the
      // deferral (district IS recorded in the audit trail — a legitimate internal
      // forensic record — but NOT in any cross-service event).
      const deferral: AuditEvent = {
        ...newEnvelope(context),
        eventType: 'AUDIT_ENTRY',
        entityType: 'APPLICATION',
        entityId: command.applicationId,
        action: 'SLOT_ASSIGNMENT_DEFERRED',
        performedBy: 'scheduling-service',
        agency: command.agency,
        metadata: {
          reason: 'NO_VENUE_FOR_DISTRICT',
          district,
          campaignId: command.campaignId,
        },
      };
      await this.deps.eventBus.publish(deferral);
      return { kind: 'NO_VENUE', applicationId: command.applicationId };
    }

    const qrInvitationCode = mintTicketId();

    // Build the PII-free claim set and sign it into the applicant's verifiable
    // QR credential (ADR-009). Only opaque ids + the PUBLIC venue location go in
    // — never the raw home district, DOB, name, or national id. The invitation
    // is valid through the end (UTC) of the exam day.
    const claims: SlotInvitationClaims = {
      v: 1,
      keyId: this.deps.invitationSigner.keyId,
      ticketId: qrInvitationCode,
      applicationId: command.applicationId,
      applicantId: command.applicantId,
      agency: command.agency,
      campaignId: command.campaignId,
      slotId: venue.venueAssignmentId,
      venueName: venue.venueName,
      examDate: venue.examDate,
      reportingTimeHour: venue.reportingTimeHour,
      issuedAt: new Date().toISOString(),
      expiresAt: `${venue.examDate}T23:59:59.000Z`,
    };
    const qrSignedToken = this.deps.invitationSigner.sign(claims);

    const event: SlotAssignedEvent = {
      ...newEnvelope(context),
      eventType: 'SLOT_ASSIGNED',
      applicantId: command.applicantId,
      applicationId: command.applicationId,
      agency: command.agency,
      campaignId: command.campaignId,
      slotId: venue.venueAssignmentId,
      district: venue.district,
      venueName: venue.venueName,
      examDate: venue.examDate,
      reportingTimeHour: venue.reportingTimeHour,
      qrInvitationCode,
      qrSignedToken,
    };
    await this.deps.eventBus.publish(event);

    // Immutable audit of the assignment (venue is public; neither the ticket id
    // nor the signed token — which carries only ids + the public venue — is PII).
    const audit: AuditEvent = {
      ...newEnvelope(context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICATION',
      entityId: command.applicationId,
      action: 'SLOT_ASSIGNED',
      performedBy: 'scheduling-service',
      agency: command.agency,
      metadata: {
        venueName: venue.venueName,
        examDate: venue.examDate,
        reportingTimeHour: venue.reportingTimeHour,
        campaignId: command.campaignId,
      },
    };
    await this.deps.eventBus.publish(audit);

    return {
      kind: 'ASSIGNED',
      applicationId: command.applicationId,
      venueName: venue.venueName,
      examDate: venue.examDate,
      qrInvitationCode,
      qrSignedToken,
      event,
    };
  }
}
