// ══════════════════════════════════════════════════════════════════
// application-service — Submit application (use case)
//
// THE FRONT DOOR of the USRP pipeline: it turns a verified applicant's
// agency+category choice into a filed application and announces it as
// APPLICANT_SUBMITTED — the event two downstream services already react to
// but nothing produced until now. Business outcomes (applicant unknown,
// identity not verified, academic credential missing, no open campaign)
// are RETURN VALUES; only malformed input (guarded at the HTTP edge) and
// infrastructure faults throw. The raw National ID never enters here — the
// applicant is referenced by opaque id, and the event carries only the
// stored national_id_hash.
//
// Ordering is deliberate: verify identity → validate academic inputs →
// resolve the open campaign → persist + stage → dispatch.
//
// ATOMIC ANNOUNCEMENT (ADR-025). APPLICANT_SUBMITTED is staged in the outbox
// IN the transaction that files the application, so the two can no longer
// disagree. Previously a broker hiccup after the commit returned a 500 for an
// application that WAS filed — inviting the citizen to file it again — and its
// vetting never started. Now the citizen gets 201 and the relay delivers.
// ══════════════════════════════════════════════════════════════════

import { newCorrelationContext, newEnvelope, type EventContext } from '@usrp/shared-events';
import { agencyForCategory, type Agency, type ApplicationCategory, type ApplicationChannel, type ApplicantSubmittedEvent } from '@usrp/shared-types';
import { resolveAcademicInputs } from '../domain/academic-input.js';
import type { IdentityReader } from '../ports/identity-reader.js';
import type { CampaignReader } from '../ports/campaign-reader.js';
import type { ApplicationRepository, CreateApplicationResult } from '../ports/application-repository.js';
import type { EventDispatcher } from '../ports/event-outbox.js';

export interface SubmitApplicationCommand {
  readonly applicantId: string;
  readonly category: ApplicationCategory;
  readonly channel: ApplicationChannel;
  readonly nesaIndexNumber?: string | null;
  readonly hecRegistrationNumber?: string | null;
  /** Inbound correlation context to continue a trace; a fresh chain when omitted. */
  readonly context?: EventContext;
}

export type SubmitApplicationOutcome =
  | {
      readonly kind: 'SUBMITTED';
      readonly applicationId: string;
      readonly processingCode: string;
      readonly agency: Agency;
      readonly event: ApplicantSubmittedEvent;
    }
  | { readonly kind: 'APPLICANT_NOT_FOUND' }
  | { readonly kind: 'IDENTITY_NOT_VERIFIED' }
  | { readonly kind: 'INVALID_ACADEMIC_INPUT'; readonly reason: string }
  | { readonly kind: 'NO_OPEN_CAMPAIGN'; readonly agency: Agency };

export interface SubmitApplicationDeps {
  readonly identityReader: IdentityReader;
  readonly campaignReader: CampaignReader;
  readonly repository: ApplicationRepository;
  /** Post-commit dispatch of the staged announcement (the outbox fast path). */
  readonly events: EventDispatcher;
}

export class SubmitApplicationService {
  constructor(private readonly deps: SubmitApplicationDeps) {}

  async submit(command: SubmitApplicationCommand): Promise<SubmitApplicationOutcome> {
    const agency = agencyForCategory(command.category);

    // 1. Identity precondition — identity-service owns NIDA; we only confirm
    //    the applicant is a known, VERIFIED identity and lift its hash.
    const identity = await this.deps.identityReader.findApplicantById(command.applicantId);
    if (identity === null) {
      return { kind: 'APPLICANT_NOT_FOUND' };
    }
    if (identity.identityStatus !== 'VERIFIED') {
      return { kind: 'IDENTITY_NOT_VERIFIED' };
    }

    // 2. Academic inputs — the category fixes which credential is required.
    const academic = resolveAcademicInputs(command.category, {
      nesaIndexNumber: command.nesaIndexNumber ?? null,
      hecRegistrationNumber: command.hecRegistrationNumber ?? null,
    });
    if (!academic.ok) {
      return { kind: 'INVALID_ACADEMIC_INPUT', reason: academic.reason };
    }

    // 3. Resolve the open campaign for this agency+category (server-side).
    const campaign = await this.deps.campaignReader.findOpenCampaign(agency, command.category);
    if (campaign === null) {
      return { kind: 'NO_OPEN_CAMPAIGN', agency };
    }

    // Resolve the trace ONCE so the persisted history row and the published
    // event carry the same correlationId (a fresh chain when none is inbound).
    const context = command.context ?? newCorrelationContext();

    // The envelope is minted BEFORE the write so the event staged inside the
    // transaction and the one dispatched/returned after it are the same event.
    const envelope = newEnvelope(context);
    const nationalIdHash = identity.nationalIdHash;
    const nesaIndexNumber = academic.resolved.nesaIndexNumber;
    const hecRegistrationNumber = academic.resolved.hecRegistrationNumber;
    const announce = (created: CreateApplicationResult): ApplicantSubmittedEvent => ({
      ...envelope,
      eventType: 'APPLICANT_SUBMITTED',
      applicantId: command.applicantId,
      applicationId: created.applicationId,
      nationalIdHash,
      agency,
      category: command.category,
      channel: command.channel,
      nesaIndexNumber,
      hecRegistrationNumber,
    });

    // 4. Persist into the owning agency's isolated ops schema (+ history), and
    //    stage APPLICANT_SUBMITTED in that same transaction.
    const created = await this.deps.repository.createApplication(
      {
        agency,
        applicantId: command.applicantId,
        campaignId: campaign.campaignId,
        category: command.category,
        channel: command.channel,
        nesaIndexNumber,
        hecRegistrationNumber,
        correlationId: context.correlationId,
      },
      (c) => [announce(c)],
    );

    // 5. Fast-path dispatch. Never throws for a transport fault: the event is
    //    already durable and the outbox relay will deliver it.
    const event = announce(created);
    await this.deps.events.dispatch([event]);

    return {
      kind: 'SUBMITTED',
      applicationId: created.applicationId,
      processingCode: created.processingCode,
      agency,
      event,
    };
  }
}
