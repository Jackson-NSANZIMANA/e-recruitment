// ══════════════════════════════════════════════════════════════════
// application-service — WalkInRepository port
//
// The walk-in lane's two durable writes (ADR-012, RDF-only):
//
//   • createWalkInApplication — a field officer registers an on-site
//     candidate on exam day: INSERT the application at WALK_IN_REGISTERED
//     (is_walk_in = true) with a freshly minted on-site ticket in
//     qr_invitation_code — the anchor SignableFieldPayload.qrInvitationCode
//     binds physical-test scores to, exactly as the scheduled lane's QR does.
//   • vetOnSite — the on-site eligibility gate: WALK_IN_REGISTERED advances
//     to WALK_IN_ON_SITE_VETTING when the autonomous AGE verdict (landed by
//     the normal vetting projection off the register's APPLICANT_SUBMITTED)
//     is ELIGIBLE, or terminates at WALK_IN_REJECTED when INELIGIBLE. A
//     still-PENDING verdict is AGE_PENDING — the tablet retries in seconds.
//
// Both run AS THE OFFICER'S DB ROLE (usrp_rdf_officer), like every officer
// write since Slice 4: the officer role has no grant on sibling ops schemas,
// so cross-agency isolation is engine-enforced. rls/0001 already grants the
// officer INSERT on applications + history and USAGE on the processing-code
// sequence (verified live) — no migration needed.
// ══════════════════════════════════════════════════════════════════

import type {
  AgeEligibilityStatus,
  ApplicationCategory,
  ApplicationStatus,
} from '@usrp/shared-types';
import type { OfficerActor } from './officer-transition-repository.js';
import type { StageEvents } from './event-outbox.js';

export interface CreateWalkInInput {
  readonly actor: OfficerActor;
  readonly applicantId: string;
  readonly campaignId: string;
  readonly category: ApplicationCategory;
  readonly nesaIndexNumber: string | null;
  readonly hecRegistrationNumber: string | null;
  /** Minted by the use case (opaque, unique) — persisted/returned only when registration wins. */
  readonly qrInvitationCode: string;
}

export interface CreateWalkInResult {
  readonly applicationId: string;
  readonly processingCode: string;
}

/**
 * Outcome of an on-site registration (ADR-027).
 *
 * The walk-in lane files into the SAME applications table the digital front
 * door does, so rls/0022's live-intent partial unique index governs it too:
 * a citizen who already applied online cannot be registered again at the
 * venue, and a double-tap on the officer's tablet cannot create two records.
 *
 * The officer needs the answer, not a 500 — ALREADY_APPLIED names the
 * application the candidate already holds so the officer can look it up and
 * continue with it instead of filing a second one.
 */
export type CreateWalkInOutcome =
  | ({ readonly kind: 'REGISTERED' } & CreateWalkInResult)
  | ({ readonly kind: 'ALREADY_APPLIED' } & CreateWalkInResult);

export interface VetOnSiteInput {
  readonly actor: OfficerActor;
  readonly applicationId: string;
}

/**
 * Outcome of the on-site vetting gate. Mirrors OfficerTransitionOutcome, with
 * one lane-specific addition: AGE_PENDING — the autonomous age verdict has not
 * landed yet (the projection consumes vetting.age within seconds of register;
 * the tablet simply retries).
 */
export type VetOnSiteOutcome =
  | {
      readonly kind: 'APPLIED';
      readonly fromStatus: ApplicationStatus;
      readonly toStatus: ApplicationStatus;
      readonly ageStatus: AgeEligibilityStatus;
    }
  | { readonly kind: 'AGE_PENDING'; readonly currentStatus: ApplicationStatus }
  | { readonly kind: 'NO_CHANGE'; readonly currentStatus: ApplicationStatus }
  | { readonly kind: 'NOT_APPLICABLE'; readonly currentStatus: ApplicationStatus }
  | { readonly kind: 'NOT_FOUND' };

export interface WalkInRepository {
  /**
   * Register an on-site candidate. Returns ALREADY_APPLIED (never throws)
   * when the engine's live-intent index refuses a second live application
   * for this (applicant, campaign, category).
   */
  createWalkInApplication(
    input: CreateWalkInInput,
    stage: StageEvents<CreateWalkInResult>,
  ): Promise<CreateWalkInOutcome>;
  vetOnSite(
    input: VetOnSiteInput,
    stage: StageEvents<VetOnSiteOutcome>,
  ): Promise<VetOnSiteOutcome>;
}
