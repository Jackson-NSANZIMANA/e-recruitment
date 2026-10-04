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
//   • registration stages APPLICANT_SUBMITTED (channel WALK_IN) and its audit
//     in the SAME transaction as application + history, then uses the outbox
//     dispatcher after commit — the SAME event the digital front door emits,
//     so the autonomous gates (age/academic/criminal) fire unchanged; the age verdict
//     is what on-site vetting reads minutes later (owner decision D2).
//   • the walk-in campaign is resolved server-side by the EXAMINATION window
//     + allows_walk_in — registration windows are closed on exam day.
//   • one AUDIT_ENTRY per genuine state change, attributed to the officer.
// ══════════════════════════════════════════════════════════════════

import { randomBytes } from 'node:crypto';
import { newCorrelationContext, newEnvelope, type EventContext } from '@usrp/shared-events';
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
import type {
  CreateWalkInResult,
  VetOnSiteOutcome,
  WalkInRepository,
} from '../ports/walk-in-repository.js';
import type { OfficerActor } from '../ports/officer-transition-repository.js';
import type { EventDispatcher } from '../ports/event-outbox.js';

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
  | { readonly kind: 'NO_WALK_IN_CAMPAIGN'; readonly agency: Agency }
  /**
   * The candidate already holds a live application for this campaign and
   * category (ADR-027) — whether filed online minutes ago or by a double-tap
   * on this tablet. Nothing was written and NOTHING is announced: emitting a
   * second APPLICANT_SUBMITTED would re-run the autonomous gates against an
   * application that is already being vetted.
   */
  | {
      readonly kind: 'ALREADY_APPLIED';
      readonly applicationId: string;
      readonly processingCode: string;
    };

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
  /** Post-commit fast path for events already durable in the outbox. */
  readonly events: EventDispatcher;
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

    // 4. Mint every envelope BEFORE opening the transaction. The stage
    //    callback below is therefore pure: it only combines immutable request
    //    data with identifiers returned by the INSERT.
    const submittedEnvelope = newEnvelope(context);
    const auditEnvelope = newEnvelope(context);
    const eventsFor = (created: CreateWalkInResult): readonly [ApplicantSubmittedEvent, AuditEvent] => [
      {
        ...submittedEnvelope,
        eventType: 'APPLICANT_SUBMITTED',
        applicantId: command.applicantId,
        applicationId: created.applicationId,
        nationalIdHash: identity.nationalIdHash,
        agency,
        category: command.category,
        channel: 'WALK_IN',
        nesaIndexNumber: academic.resolved.nesaIndexNumber,
        hecRegistrationNumber: academic.resolved.hecRegistrationNumber,
      },
      {
        ...auditEnvelope,
        eventType: 'AUDIT_ENTRY',
        entityType: 'APPLICATION',
        entityId: created.applicationId,
        action: 'WALK_IN_REGISTERED',
        performedBy: command.actor.subjectId,
        agency,
        newStatus: 'WALK_IN_REGISTERED',
        metadata: { category: command.category, processingCode: created.processingCode },
      },
    ];

    // Persist application + history + both events as one atomic unit. The
    // opaque ticket is generated before the attempted INSERT, but on a
    // duplicate it is neither persisted nor returned.
    const qrInvitationCode = randomBytes(32).toString('base64url');
    const created = await this.#deps.repository.createWalkInApplication(
      {
        actor,
        applicantId: command.applicantId,
        campaignId: campaign.campaignId,
        category: command.category,
        nesaIndexNumber: academic.resolved.nesaIndexNumber,
        hecRegistrationNumber: academic.resolved.hecRegistrationNumber,
        qrInvitationCode,
      },
      eventsFor,
    );

    // Duplicate: no row, no ticket persisted or returned, no event, and no
    // audit of a registration that did not happen. The officer is handed the
    // application already on file.
    if (created.kind === 'ALREADY_APPLIED') {
      return {
        kind: 'ALREADY_APPLIED',
        applicationId: created.applicationId,
        processingCode: created.processingCode,
      };
    }

    // 5. Post-commit fast path only. These exact envelopes are already durable
    //    in event_outbox; a broker fault cannot make registration look failed.
    const durableEvents = eventsFor(created);
    await this.#deps.events.dispatch(durableEvents);

    return {
      kind: 'REGISTERED',
      applicationId: created.applicationId,
      processingCode: created.processingCode,
      qrInvitationCode,
      event: durableEvents[0],
    };
  }

  async vetOnSite(command: VetWalkInCommand): Promise<VetWalkInOutcome> {
    if (command.actor.kind !== 'officer') return { kind: 'FORBIDDEN' };
    if (!WALK_IN_AGENCIES.has(command.actor.agency)) {
      return { kind: 'UNSUPPORTED_AGENCY', agency: command.actor.agency };
    }
    const actor = toActor(command.actor, command.context);
    const auditEnvelope = newEnvelope(command.context);
    const eventsFor = (outcome: VetOnSiteOutcome): readonly AuditEvent[] => {
      if (outcome.kind !== 'APPLIED') return [];
      return [{
        ...auditEnvelope,
        eventType: 'AUDIT_ENTRY',
        entityType: 'APPLICATION',
        entityId: command.applicationId,
        action:
          outcome.toStatus === 'WALK_IN_REJECTED'
            ? 'APPLICATION_REJECTED'
            : 'APPLICATION_STATUS_ADVANCED',
        performedBy: actor.officerId,
        agency: actor.agency,
        previousStatus: outcome.fromStatus,
        newStatus: outcome.toStatus,
        metadata: { stage: 'WALK_IN_ON_SITE_VETTING', ageStatus: outcome.ageStatus },
      }];
    };
    const outcome = await this.#deps.repository.vetOnSite(
      { actor, applicationId: command.applicationId },
      eventsFor,
    );

    if (outcome.kind === 'APPLIED') {
      await this.#deps.events.dispatch(eventsFor(outcome));
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
