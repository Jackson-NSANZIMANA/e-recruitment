// application-service — ExamInvitationReader port (ADR-033)
//
// The citizen's own application, subject-scoped: the only way the stored
// invitation token leaves the database.

import type { Agency, ApplicationStatus } from '@usrp/shared-types';

export interface InvitationRow {
  readonly agency: Agency;
  readonly status: ApplicationStatus;
  readonly processingCode: string;
  readonly campaignLabel: string | null;
  readonly token: string | null;
  /** The gate admission, once the QR has been spent (rls/0032). */
  readonly admission: { readonly admittedAt: string; readonly venueName: string } | null;
}

export interface ExamInvitationReader {
  /** Null when the application is not this applicant's (or does not exist). */
  findForApplicant(applicantId: string, applicationId: string): Promise<InvitationRow | null>;
}
