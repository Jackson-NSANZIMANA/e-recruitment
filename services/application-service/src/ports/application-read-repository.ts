// ══════════════════════════════════════════════════════════════════
// application-service — ApplicationReadRepository port (officer read)
//
// The read side of the applications table for an authenticated officer. It
// is DELIBERATELY separate from the write ApplicationRepository: the write
// paths run as usrp_system_service, but this read runs as the officer's OWN
// agency DB role (usrp_<agency>_officer) so the dormant per-agency schema
// isolation from rls/0001 finally enforces on a live request. The caller
// resolves the DbRole from the verified Principal (dbRoleForPrincipal); the
// adapter is a dumb executor that assumes the role it is told.
// ══════════════════════════════════════════════════════════════════

import type { Agency, ApplicationCategory, ApplicationStatus } from '@usrp/shared-types';
import type { DbRole } from '@usrp/shared-auth';

/** A non-PII summary row — the anonymous processing code, never a name/NID. */
export interface ApplicationSummary {
  readonly applicationId: string;
  readonly processingCode: string;
  readonly category: ApplicationCategory;
  readonly status: ApplicationStatus;
  readonly submittedAt: string | null;
}

export interface ListByAgencyInput {
  readonly agency: Agency;
  readonly dbRole: DbRole;
  readonly limit: number;
}

export interface ApplicationReadRepository {
  /** List an agency's applications, executed under the officer's DB role. */
  listByAgency(input: ListByAgencyInput): Promise<readonly ApplicationSummary[]>;
}
