// application-service — Stalled-clearance port (slot re-announce sweep)
//
// An application cleared into DOCUMENT_REVIEW_GREEN whose slot never arrived
// (scheduling deferred it: no venue for the district yet, or the venue was full
// or inactive). See ReannounceStalledClearancesService.

import type { Agency, ApplicationCategory, USRPEvent } from '@usrp/shared-types';

export interface StalledClearance {
  readonly applicationId: string;
  readonly applicantId: string;
  readonly agency: Agency;
  readonly campaignId: string;
  readonly category: ApplicationCategory;
}

export interface StalledClearanceRepository {
  /**
   * Claim up to `limit` stalled clearances per agency untouched since
   * `untouchedSince` (row-locked, SKIP LOCKED: replicas never claim the same
   * row), stage the events `announce` builds for them in the outbox, and mark
   * each row touched, all in one transaction. Returns the staged events.
   */
  reannounce(
    untouchedSince: Date,
    limit: number,
    announce: (stalled: readonly StalledClearance[]) => readonly USRPEvent[],
  ): Promise<readonly USRPEvent[]>;
}
