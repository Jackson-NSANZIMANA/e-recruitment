// ══════════════════════════════════════════════════════════════════
// scheduling-service — Assign exam slot (use case)
//
// The scheduling gate. Triggered by APPLICATION_ELIGIBILITY_CLEARED, it reads +
// decrypts the applicant's home district, resolves the venue that district
// reports to for the campaign, reserves a SEAT there, mints + signs the QR
// invitation, and announces SLOT_ASSIGNED (which application-service's
// projection stamps onto the row) plus an AUDIT_ENTRY of the decision.
//
// ONE INVITATION PER APPLICATION (ADR-026). ADR-025 made CLEARED
// at-least-once on purpose. Before this, every repeat minted a NEW ticket and
// a NEW signed QR: the projection kept the first, notification-service sent
// them all, and the field tablet (wave 1: ticket-bound scores) refuses every
// ticket but the first. Now the decision is recorded in the slot ledger in the
// same transaction that counts the seat and stages the announcement, and a
// redelivery re-announces the STORED event: same eventId, ticket, token.
//
// Business outcomes are RETURN VALUES:
//   • ASSIGNED            — seat reserved, SLOT_ASSIGNED + audit staged.
//   • ALREADY_ASSIGNED    — decided before; the original SLOT_ASSIGNED is
//                           re-announced verbatim. Nothing minted.
//   • NO_VENUE            — no venue for this (campaign, district), e.g. RNP
//                           whose list is unpublished. Deferral audited, the
//                           application holds at DOCUMENT_REVIEW_GREEN.
//   • NO_CAPACITY         — the venue is full (or was deactivated mid-flight).
//                           Deferral audited with the reason, holds at GREEN.
//   • APPLICANT_NOT_FOUND — identity missing/erased.
// Only infrastructure faults throw; the bus retries, then dead-letters.
//
// COMPLIANCE: the raw home district never appears in a cross-service event or
// log, only the RESOLVED venue (a public location). The district is recorded in
// the internal audit trail on a NO_VENUE deferral only, as before.
// ══════════════════════════════════════════════════════════════════

import { randomBytes } from 'node:crypto';
import { newCorrelationContext, newEnvelope, type EventContext } from '@usrp/shared-events';
import type { Agency, AuditEvent, SlotAssignedEvent, SlotInvitationClaims } from '@usrp/shared-types';
import type { HomeDistrictReader, VenueReader } from '../ports/readers.js';
import type {
  EventDispatcher,
  NoCapacityReason,
  ReserveSlotOutcome,
  SlotLedger,
} from '../ports/slot-ledger.js';

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
  | {
      readonly kind: 'ALREADY_ASSIGNED';
      readonly applicationId: string;
      /** The SLOT_ASSIGNED announced the first time, re-announced verbatim. */
      readonly event: SlotAssignedEvent;
    }
  | { readonly kind: 'NO_VENUE'; readonly applicationId: string }
  | { readonly kind: 'NO_CAPACITY'; readonly applicationId: string; readonly reason: NoCapacityReason }
  | { readonly kind: 'APPLICANT_NOT_FOUND'; readonly applicantId: string };

export interface AssignSlotDeps {
  readonly districtReader: HomeDistrictReader;
  readonly venueReader: VenueReader;
  /** The decision of record: one reservation per application, seats counted. */
  readonly ledger: SlotLedger;
  /** Post-commit dispatch of staged events (the outbox fast path). */
  readonly events: EventDispatcher;
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
    // 0. Decided before? Answer with the decision of record. Checked FIRST so a
    //    redelivery decrypts no PII and mints nothing. Re-announcing is what
    //    keeps at-least-once delivery honest downstream: a consumer that missed
    //    the original still converges, on the SAME ticket.
    const existing = await this.deps.ledger.findReservation(command.applicationId);
    if (existing !== null) {
      await this.deps.events.dispatch([existing]);
      return { kind: 'ALREADY_ASSIGNED', applicationId: command.applicationId, event: existing };
    }

    const district = await this.deps.districtReader.homeDistrictOf(command.applicantId);
    if (district === null) {
      return { kind: 'APPLICANT_NOT_FOUND', applicantId: command.applicantId };
    }

    const venue = await this.deps.venueReader.venueFor(command.campaignId, district);
    const context = command.context ?? newCorrelationContext();

    if (venue === null) {
      // No venue for this district/campaign — defer, don't fabricate. The
      // district IS recorded in the audit trail (a legitimate internal forensic
      // record) but NOT in any cross-service event. Staged, so it is durable.
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
      await this.deps.ledger.recordDeferral([deferral]);
      await this.deps.events.dispatch([deferral]);
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

    // Every envelope is minted BEFORE the transaction, so the stage callback is
    // pure and the staged events are the dispatched events (same eventIds).
    const slotEvent: SlotAssignedEvent = {
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

    // Immutable audit of the assignment (venue is public; neither the ticket id
    // nor the signed token — which carries only ids + the public venue — is PII).
    const assignedAudit: AuditEvent = {
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

    const capacityEnvelope = newEnvelope(context);
    const capacityDeferral = (
      outcome: Extract<ReserveSlotOutcome, { readonly kind: 'NO_CAPACITY' }>,
    ): AuditEvent => ({
      ...capacityEnvelope,
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICATION',
      entityId: command.applicationId,
      action: 'SLOT_ASSIGNMENT_DEFERRED',
      performedBy: 'scheduling-service',
      agency: command.agency,
      metadata: {
        reason: outcome.reason,
        // The venue is public; the district is deliberately NOT recorded here.
        venueName: venue.venueName,
        venueAssignmentId: venue.venueAssignmentId,
        capacityLimit: outcome.capacityLimit,
        registeredCount: outcome.registeredCount,
        campaignId: command.campaignId,
      },
    });

    const outcome = await this.deps.ledger.reserve(
      {
        applicationId: command.applicationId,
        agency: command.agency,
        campaignId: command.campaignId,
        venueAssignmentId: venue.venueAssignmentId,
        slotEvent,
      },
      (o) =>
        o.kind === 'RESERVED' ? [slotEvent, assignedAudit] : o.kind === 'NO_CAPACITY' ? [capacityDeferral(o)] : [],
    );

    switch (outcome.kind) {
      case 'RESERVED':
        await this.deps.events.dispatch([slotEvent, assignedAudit]);
        return {
          kind: 'ASSIGNED',
          applicationId: command.applicationId,
          venueName: venue.venueName,
          examDate: venue.examDate,
          qrInvitationCode,
          qrSignedToken,
          event: slotEvent,
        };
      case 'ALREADY_ASSIGNED':
        // Lost a race to a concurrent delivery. The ticket minted above never
        // left this process; the winner's invitation is the only one.
        await this.deps.events.dispatch([outcome.event]);
        return { kind: 'ALREADY_ASSIGNED', applicationId: command.applicationId, event: outcome.event };
      case 'NO_CAPACITY':
        await this.deps.events.dispatch([capacityDeferral(outcome)]);
        return { kind: 'NO_CAPACITY', applicationId: command.applicationId, reason: outcome.reason };
    }
  }
}
