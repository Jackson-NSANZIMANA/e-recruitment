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

/**
 * One row of the officer review queue (ADR-011) — an application held at
 * DOCUMENT_REVIEW_AMBER (with its flagged document's forensic signals) or at
 * ADJUDICATION_REVIEW (a late-disqualification hold; document fields null).
 * Non-PII by construction: the processing code stands in for the applicant.
 */
export interface AmberQueueEntry {
  readonly applicationId: string;
  readonly processingCode: string;
  readonly status: ApplicationStatus;
  readonly documentType: string | null;
  readonly forensicsScore: number | null;
  /** The stored ForensicsFlags jsonb, verbatim (null for adjudication holds). */
  readonly forensicsFlags: Record<string, unknown> | null;
  readonly queuedAt: string | null;
}

export interface ApplicationReadRepository {
  /** List an agency's applications, executed under the officer's DB role. */
  listByAgency(input: ListByAgencyInput): Promise<readonly ApplicationSummary[]>;
  /**
   * List the officer's agency review queue: applications at
   * DOCUMENT_REVIEW_AMBER joined to their un-reviewed AMBER document rows,
   * plus applications at ADJUDICATION_REVIEW. Officer DB role; non-PII.
   */
  listAmberQueue(input: ListByAgencyInput): Promise<readonly AmberQueueEntry[]>;
}
