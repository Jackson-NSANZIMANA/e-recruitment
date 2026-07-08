// ══════════════════════════════════════════════════════════════════
// application-service — ApplicationRepository port
//
// Persists a new application into the OWNING agency's isolated ops schema
// (rdf_ops / rnp_ops / rcs_ops). One transaction does three things
// atomically: mint the per-agency processing code from that schema's
// sequence, INSERT the applications row (status SUBMITTED), and INSERT the
// initial null→SUBMITTED application_status_history row (the immutable
// trail's first entry). All as usrp_system_service.
// ══════════════════════════════════════════════════════════════════

import type { Agency, ApplicationCategory, ApplicationChannel } from '@usrp/shared-types';

/** Everything needed to file one application under a resolved campaign. */
export interface CreateApplicationInput {
  readonly agency: Agency;
  readonly applicantId: string;
  readonly campaignId: string;
  readonly category: ApplicationCategory;
  readonly channel: ApplicationChannel;
  readonly nesaIndexNumber: string | null;
  readonly hecRegistrationNumber: string | null;
  /** Correlation id of the causal chain — recorded on the history row. */
  readonly correlationId: string;
}

/** Identifiers of the created application. */
export interface CreateApplicationResult {
  readonly applicationId: string;
  readonly processingCode: string;
}

export interface ApplicationRepository {
  createApplication(input: CreateApplicationInput): Promise<CreateApplicationResult>;
}
