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
// resolve the open campaign → persist → publish. Cheaper/clearer
// rejections come first, and the event is published only after the
// application is durably persisted, so a consumer never sees a submission
// that isn't recorded.
// ══════════════════════════════════════════════════════════════════

import { newCorrelationContext, newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import { agencyForCategory, type Agency, type ApplicationCategory, type ApplicationChannel, type ApplicantSubmittedEvent } from '@usrp/shared-types';
import { resolveAcademicInputs } from '../domain/academic-input.js';
import type { IdentityReader } from '../ports/identity-reader.js';
import type { CampaignReader } from '../ports/campaign-reader.js';
import type { ApplicationRepository } from '../ports/application-repository.js';

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
  readonly eventBus: EventBus;
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

    // 4. Persist into the owning agency's isolated ops schema (+ history).
    const created = await this.deps.repository.createApplication({
      agency,
      applicantId: command.applicantId,
      campaignId: campaign.campaignId,
      category: command.category,
      channel: command.channel,
      nesaIndexNumber: academic.resolved.nesaIndexNumber,
      hecRegistrationNumber: academic.resolved.hecRegistrationNumber,
      correlationId: context.correlationId,
    });

    // 5. Announce it. Published only after durable persistence above.
    const event: ApplicantSubmittedEvent = {
      ...newEnvelope(context),
      eventType: 'APPLICANT_SUBMITTED',
      applicantId: command.applicantId,
      applicationId: created.applicationId,
      nationalIdHash: identity.nationalIdHash,
      agency,
      category: command.category,
      channel: command.channel,
      nesaIndexNumber: academic.resolved.nesaIndexNumber,
      hecRegistrationNumber: academic.resolved.hecRegistrationNumber,
    };
    await this.deps.eventBus.publish(event);

    return {
      kind: 'SUBMITTED',
      applicationId: created.applicationId,
      processingCode: created.processingCode,
      agency,
      event,
    };
  }
}
