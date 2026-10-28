// ══════════════════════════════════════════════════════════════════
// application-service — ClearanceAttachRepository port (ADR-048 §2.3)
//
// The read behind "the applicant gives the number of their criminal-record
// certificate": which application, in which agency, in what state, owned by
// whom. A usrp_system_service read (the citizen is cross-agency; the portal
// backend holds a system token), with ownership inside the lookup: a
// mismatch on either id is the same NOT_FOUND, so the door is no ownership
// oracle. Nothing is written here: the number travels in an event and is
// never stored by application-service.
// ══════════════════════════════════════════════════════════════════

import type { Agency, ApplicationCategory, ApplicationStatus, CriminalClearanceStatus } from '@usrp/shared-types';

export interface OwnApplicationForClearance {
  readonly agency: Agency;
  readonly category: ApplicationCategory;
  readonly status: ApplicationStatus;
  readonly criminalStatus: CriminalClearanceStatus;
}

export interface ClearanceAttachRepository {
  /** The caller's OWN application, or null (absent or someone else's). */
  findOwn(applicantId: string, applicationId: string): Promise<OwnApplicationForClearance | null>;
}
