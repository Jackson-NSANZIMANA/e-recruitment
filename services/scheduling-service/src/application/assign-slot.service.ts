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
import type { Agency, AuditEvent, SlotAssignedEvent } from '@usrp/shared-types';
import type { HomeDistrictReader, VenueReader } from '../ports/readers.js';

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
      readonly event: SlotAssignedEvent;
    }
  | { readonly kind: 'NO_VENUE'; readonly applicationId: string }
  | { readonly kind: 'APPLICANT_NOT_FOUND'; readonly applicantId: string };

export interface AssignSlotDeps {
  readonly districtReader: HomeDistrictReader;
  readonly venueReader: VenueReader;
  readonly eventBus: EventBus;
}

/** Mint an opaque, URL-safe QR invitation token (32 bytes → 43 base64url chars). */
function mintQrInvitationCode(): string {
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

    const qrInvitationCode = mintQrInvitationCode();
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
    };
    await this.deps.eventBus.publish(event);

    // Immutable audit of the assignment (venue is public; QR is an opaque token).
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
      event,
    };
  }
}
