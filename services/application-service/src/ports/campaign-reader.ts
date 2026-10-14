// ══════════════════════════════════════════════════════════════════
// application-service — CampaignReader port
//
// An application must belong to a recruitment campaign that is OPEN for
// registration and accepts the chosen category. The applicant chooses an
// agency+category, never a campaign UUID — so the front door resolves the
// open campaign server-side. This port finds the campaign the submission
// should attach to, applying the registration-window and target-category
// rules; a null result is a business rejection (NO_OPEN_CAMPAIGN), not an
// error.
// ══════════════════════════════════════════════════════════════════

import type { Agency, ApplicationCategory } from '@usrp/shared-types';

/** The resolved open campaign an application will be filed under. */
export interface OpenCampaign {
  readonly campaignId: string;
  readonly campaignLabel: string;
  /**
   * The immutable policy version the campaign points at NOW. Captured onto the
   * application at filing so later amendments never rewrite its evaluation.
   * Null for campaigns published before BUILD-001.
   */
  readonly policyVersionId: string | null;
}

export interface CampaignReader {
  /**
   * Find the single campaign that is REGISTRATION_OPEN for `agency`, whose
   * registration window contains now, and whose target_categories include
   * `category`. Returns null when none qualifies.
   */
  findOpenCampaign(agency: Agency, category: ApplicationCategory): Promise<OpenCampaign | null>;

  /**
   * Resolve the campaign the citizen CHOSE by its public code (BUILD-002).
   * Same qualification rules as `findOpenCampaign` — REGISTRATION_OPEN,
   * window contains now, agency matches, category targeted — but over exactly
   * one named campaign, so two simultaneous openings can never be confused.
   * Null covers "no such code", "not open", and "does not accept this
   * category": the public code is not a secret, but the distinction is not
   * worth an oracle either.
   */
  findOpenCampaignByCode(
    publicCode: string,
    agency: Agency,
    category: ApplicationCategory,
  ): Promise<OpenCampaign | null>;

  /**
   * Find the campaign a WALK-IN registration attaches to (ADR-012). Walk-in
   * happens ON EXAM DAY, after registration closes — so the qualifying window
   * is the EXAMINATION window (start/end dates contain today), the campaign
   * must allow walk-ins (allows_walk_in), belong to `agency`, target
   * `category`, and be in an active state (not DRAFT/COMPLETED/CANCELLED).
   * Returns null when none qualifies (NO_WALK_IN_CAMPAIGN).
   */
  findWalkInCampaign(agency: Agency, category: ApplicationCategory): Promise<OpenCampaign | null>;
}
