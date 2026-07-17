// ══════════════════════════════════════════════════════════════════
// application-service — Walk-in registration + on-site vetting (use case)
//
// THE WALK-IN LANE's front door (ADR-012, RDF-only): a field officer at the
// exam venue registers an on-site candidate whose identity was JUST verified
// via identity-service (online NIDA — owner decision D1), then gates them
// through on-site vetting before the physical test.
//
// Policy owned here (the repository owns only the durable writes):
//   • RDF-only — walk-in is an RDF recruitment concept; the WALK_IN_* enum
//     values exist ONLY in rdf_ops (verified live). Any other agency gets a
//     clean UNSUPPORTED_AGENCY (the medical-501 divergence pattern), never a
//     raw DB enum error.
//   • agency/dbRole/officerId come from the VERIFIED principal, never the body.
//   • registration emits APPLICANT_SUBMITTED (channel WALK_IN) AFTER durable
//     persistence — the SAME event the digital front door emits, so the
//     autonomous gates (age/academic/criminal) fire unchanged; the age verdict
//     is what on-site vetting reads minutes later (owner decision D2).
//   • the walk-in campaign is resolved server-side by the EXAMINATION window
//     + allows_walk_in — registration windows are closed on exam day.
//   • one AUDIT_ENTRY per genuine state change, attributed to the officer.
// ══════════════════════════════════════════════════════════════════

import { randomBytes } from 'node:crypto';
import { newCorrelationContext, newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import {
  agencyForCategory,
  type Agency,
  type ApplicantSubmittedEvent,
  type ApplicationCategory,
  type AuditEvent,
} from '@usrp/shared-types';
import { dbRoleForPrincipal, type Principal } from '@usrp/shared-auth';
import { resolveAcademicInputs } from '../domain/academic-input.js';
import type { IdentityReader } from '../ports/identity-reader.js';
import type { CampaignReader } from '../ports/campaign-reader.js';
import type { VetOnSiteOutcome, WalkInRepository } from '../ports/walk-in-repository.js';
import type { OfficerActor } from '../ports/officer-transition-repository.js';

/** Agencies whose ops schema models the walk-in lane (rdf_ops only, verified). */
const WALK_IN_AGENCIES: ReadonlySet<Agency> = new Set<Agency>(['RDF']);

export interface RegisterWalkInCommand {
  readonly actor: Principal;
  readonly applicantId: string;
  readonly category: ApplicationCategory;
  readonly nesaIndexNumber?: string | null;
  readonly hecRegistrationNumber?: string | null;
  readonly context?: EventContext;
}

export type RegisterWalkInOutcome =
  | {
      readonly kind: 'REGISTERED';
      readonly applicationId: string;
      readonly processingCode: string;
      readonly qrInvitationCode: string;
      readonly event: ApplicantSubmittedEvent;
    }
  | { readonly kind: 'FORBIDDEN' }
  | { readonly kind: 'UNSUPPORTED_AGENCY'; readonly agency: Agency }
  | { readonly kind: 'WRONG_AGENCY_CATEGORY'; readonly categoryAgency: Agency }
  | { readonly kind: 'APPLICANT_NOT_FOUND' }
  | { readonly kind: 'IDENTITY_NOT_VERIFIED' }
  | { readonly kind: 'INVALID_ACADEMIC_INPUT'; readonly reason: string }
  | { readonly kind: 'NO_WALK_IN_CAMPAIGN'; readonly agency: Agency };

export interface VetWalkInCommand {
  readonly actor: Principal;
  readonly applicationId: string;
  readonly context: EventContext;
}

export type VetWalkInOutcome =
  | VetOnSiteOutcome
  | { readonly kind: 'FORBIDDEN' }
  | { readonly kind: 'UNSUPPORTED_AGENCY'; readonly agency: Agency };

export interface WalkInDeps {
  readonly identityReader: IdentityReader;
  readonly campaignReader: CampaignReader;
  readonly repository: WalkInRepository;
  readonly eventBus: EventBus;
}

export class WalkInService {
  readonly #deps: WalkInDeps;

  constructor(deps: WalkInDeps) {
    this.#deps = deps;
  }

  async register(command: RegisterWalkInCommand): Promise<RegisterWalkInOutcome> {
    if (command.actor.kind !== 'officer') return { kind: 'FORBIDDEN' };
    const agency = command.actor.agency;
    if (!WALK_IN_AGENCIES.has(agency)) {
      return { kind: 'UNSUPPORTED_AGENCY', agency };
    }
    // The category must belong to the officer's own agency — an RDF officer
    // cannot file an RNP category (the row lives in the officer's schema).
    const categoryAgency = agencyForCategory(command.category);
    if (categoryAgency !== agency) {
      return { kind: 'WRONG_AGENCY_CATEGORY', categoryAgency };
    }

    // 1. Identity precondition — the on-site NIDA verification just performed
    //    via identity-service must have yielded a VERIFIED identity.
    const identity = await this.#deps.identityReader.findApplicantById(command.applicantId);
    if (identity === null) return { kind: 'APPLICANT_NOT_FOUND' };
    if (identity.identityStatus !== 'VERIFIED') return { kind: 'IDENTITY_NOT_VERIFIED' };

    // 2. Academic inputs — same fail-closed category/credential contract as
    //    the digital front door.
    const academic = resolveAcademicInputs(command.category, {
      nesaIndexNumber: command.nesaIndexNumber ?? null,
      hecRegistrationNumber: command.hecRegistrationNumber ?? null,
    });
    if (!academic.ok) return { kind: 'INVALID_ACADEMIC_INPUT', reason: academic.reason };

    // 3. The walk-in campaign: examination window contains today + allows_walk_in.
    const campaign = await this.#deps.campaignReader.findWalkInCampaign(agency, command.category);
    if (campaign === null) return { kind: 'NO_WALK_IN_CAMPAIGN', agency };

    const context = command.context ?? newCorrelationContext();
    const actor = toActor(command.actor, context);

    // 4. Persist at WALK_IN_REGISTERED as the officer's DB role, minting the
    //    on-site ticket the physical-test capture will bind scores to (same
    //    opaque shape as the scheduled lane's QR ticket id).
    const qrInvitationCode = randomBytes(32).toString('base64url');
    const created = await this.#deps.repository.createWalkInApplication({
      actor,
      applicantId: command.applicantId,
      campaignId: campaign.campaignId,
      category: command.category,
      nesaIndexNumber: academic.resolved.nesaIndexNumber,
      hecRegistrationNumber: academic.resolved.hecRegistrationNumber,
      qrInvitationCode,
    });

    // 5. Announce it — the SAME event as the digital front door (channel
    //    WALK_IN), so the autonomous age/academic/criminal gates fire
    //    unchanged. Published only after durable persistence.
    const event: ApplicantSubmittedEvent = {
      ...newEnvelope(context),
      eventType: 'APPLICANT_SUBMITTED',
      applicantId: command.applicantId,
      applicationId: created.applicationId,
      nationalIdHash: identity.nationalIdHash,
      agency,
      category: command.category,
      channel: 'WALK_IN',
      nesaIndexNumber: academic.resolved.nesaIndexNumber,
      hecRegistrationNumber: academic.resolved.hecRegistrationNumber,
    };
    await this.#deps.eventBus.publish(event);

    const audit: AuditEvent = {
      ...newEnvelope(context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICATION',
      entityId: created.applicationId,
      action: 'WALK_IN_REGISTERED',
      performedBy: command.actor.subjectId,
      agency,
      newStatus: 'WALK_IN_REGISTERED',
      metadata: { category: command.category, processingCode: created.processingCode },
    };
    await this.#deps.eventBus.publish(audit);

    return {
      kind: 'REGISTERED',
      applicationId: created.applicationId,
      processingCode: created.processingCode,
      qrInvitationCode,
      event,
    };
  }

  async vetOnSite(command: VetWalkInCommand): Promise<VetWalkInOutcome> {
    if (command.actor.kind !== 'officer') return { kind: 'FORBIDDEN' };
    if (!WALK_IN_AGENCIES.has(command.actor.agency)) {
      return { kind: 'UNSUPPORTED_AGENCY', agency: command.actor.agency };
    }
    const actor = toActor(command.actor, command.context);
    const outcome = await this.#deps.repository.vetOnSite({
      actor,
      applicationId: command.applicationId,
    });

    if (outcome.kind === 'APPLIED') {
      const audit: AuditEvent = {
        ...newEnvelope(command.context),
        eventType: 'AUDIT_ENTRY',
        entityType: 'APPLICATION',
        entityId: command.applicationId,
        action:
          outcome.toStatus === 'WALK_IN_REJECTED'
            ? 'APPLICATION_REJECTED'
            : 'APPLICATION_STATUS_ADVANCED',
        performedBy: command.actor.subjectId,
        agency: command.actor.agency,
        previousStatus: outcome.fromStatus,
        newStatus: outcome.toStatus,
        metadata: { stage: 'WALK_IN_ON_SITE_VETTING', ageStatus: outcome.ageStatus },
      };
      await this.#deps.eventBus.publish(audit);
    }
    return outcome;
  }
}

/** Build the repository actor from a VERIFIED officer principal + context. */
function toActor(officer: Extract<Principal, { kind: 'officer' }>, context: EventContext): OfficerActor {
  return {
    agency: officer.agency,
    dbRole: dbRoleForPrincipal(officer),
    officerId: officer.subjectId,
    correlationId: context.correlationId,
  };
}
