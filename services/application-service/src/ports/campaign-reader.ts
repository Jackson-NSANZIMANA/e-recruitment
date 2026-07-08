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
}

export interface CampaignReader {
  /**
   * Find the single campaign that is REGISTRATION_OPEN for `agency`, whose
   * registration window contains now, and whose target_categories include
   * `category`. Returns null when none qualifies.
   */
  findOpenCampaign(agency: Agency, category: ApplicationCategory): Promise<OpenCampaign | null>;
}
