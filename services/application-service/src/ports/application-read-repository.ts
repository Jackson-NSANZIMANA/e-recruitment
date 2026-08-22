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

/** Addressing ONE application within the caller's own agency schema. */
export interface ReadOneInput {
  readonly agency: Agency;
  readonly dbRole: DbRole;
  readonly applicationId: string;
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

/** An applicant-facing summary row — the agency joins the non-PII summary. */
export interface ApplicantApplicationSummary extends ApplicationSummary {
  readonly agency: Agency;
}

/**
 * The full non-PII view of ONE application — what the officer console's
 * detail screen renders.
 *
 * TWO OMISSIONS ARE SECURITY DECISIONS, NOT OVERSIGHTS:
 *
 *   • `applicant_id` is absent. The anonymous processing code stands in for
 *     the applicant on every officer surface; nothing here reveals WHO.
 *   • `qr_invitation_code` is absent even though the column exists. It is a
 *     BEARER CREDENTIAL the field officer scans at the venue — returning it in
 *     a read would publish an invitation token to every console session able
 *     to open the record.
 *
 * The column set is the INTERSECTION of the three ops schemas.
 * medical_reviewed_*, is_walk_in, document_review_notes and
 * sms_notification_status exist in rdf_ops but NOT rcs_ops — selecting them
 * here would make this read throw for RCS officers and nobody else, which is
 * exactly the class of bug that survives to production. Agency-divergent
 * fields need an explicitly per-agency read.
 *
 * Per-agency enum VALUES also diverge (rcs_ops adds FLAGGED_PROSECUTION to
 * criminal_clearance_status), so those three columns are typed `string`. A
 * schema-agnostic port cannot honestly claim one agency's enum union.
 */
export interface ApplicationDetail {
  readonly applicationId: string;
  readonly processingCode: string;
  readonly category: ApplicationCategory;
  readonly status: ApplicationStatus;

  // ── Academic vetting ──
  readonly nesaIndexNumber: string | null;
  readonly nesaVerifiedAt: string | null;
  readonly hecRegistrationNumber: string | null;
  readonly hecVerifiedAt: string | null;
  readonly declaredSpecialistField: string | null;
  readonly academicStatus: string;
  /** `{ eligible, reason, details }` jsonb, verbatim. */
  readonly academicEligibilityDetail: Record<string, unknown> | null;

  // ── Age vetting (DOB-free by construction — ADR-006 age gate) ──
  readonly ageEligibilityStatus: string;
  readonly ageVerifiedAt: string | null;
  /** `{ eligible, ageAtEvaluation, appliedMaxAge, reason }` — never the DOB. */
  readonly ageEligibilityDetail: Record<string, unknown> | null;

  // ── Criminal vetting ──
  readonly criminalClearanceStatus: string;
  readonly criminalClearanceAt: string | null;

  // ── Document forensics ──
  readonly documentLane: string | null;
  readonly documentForensicsScore: number | null;
  readonly documentForensicsFlags: Record<string, unknown> | null;
  readonly documentReviewedById: string | null;
  readonly documentReviewedAt: string | null;
  readonly documentReviewDecision: string | null;

  // ── Scheduling + physical test ──
  readonly assignedDistrict: string | null;
  readonly assignedVenueName: string | null;
  readonly physicalTestScheduledAt: string | null;
  readonly physicalTestCompletedAt: string | null;
  readonly qrInvitationIssuedAt: string | null;
  readonly smsNotificationSentAt: string | null;

  // ── Final decision ──
  readonly finalDecisionById: string | null;
  readonly finalDecisionAt: string | null;
  readonly finalDecisionNotes: string | null;

  readonly submittedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One entry of the immutable status trail (rls/0007 — append-only by trigger
 * AND by revoked UPDATE/DELETE grant). This is the record a rejected applicant
 * is entitled to see reasons from, so every field that answers
 * "who changed what, when, and why" is carried:
 *
 *   actor      — 'SYSTEM' or the officer's token `sub` (a UUID)
 *   actorKind  — derived, so the UI can render a human vs an automated step
 *                without string-matching 'SYSTEM' in three components
 *   note       — the stored `reason`
 *   at         — when
 *   from/to    — the transition itself
 */
export interface StatusHistoryEntry {
  readonly entryId: string;
  readonly fromStatus: ApplicationStatus | null;
  readonly toStatus: ApplicationStatus;
  readonly note: string | null;
  readonly actor: string;
  readonly actorKind: 'SYSTEM' | 'OFFICER';
  readonly at: string;
  /** Ties the entry to the causal chain that produced it (Kafka correlationId). */
  readonly correlationId: string | null;
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
  /**
   * ALL of one applicant's applications across the three ops schemas, as
   * usrp_system_service — the cross-agency self-service read behind the
   * applicant portal's "my applications" (ADR-018). The caller has already
   * authenticated the citizen and supplies THEIR OWN applicantId; nothing
   * here is officer-scoped. Non-PII columns only.
   */
  listByApplicant(applicantId: string): Promise<readonly ApplicantApplicationSummary[]>;
  /**
   * ONE application from the officer's OWN agency schema, or null.
   *
   * null covers BOTH "no such application" and "belongs to another agency",
   * and that conflation is the point: the query only touches the caller's own
   * schema, so the two cases are indistinguishable to the caller and 404
   * cannot be used as a cross-agency existence oracle.
   */
  findById(input: ReadOneInput): Promise<ApplicationDetail | null>;
  /**
   * The append-only status trail for ONE application, oldest first. Returns
   * null when the application does not exist in the officer's own schema —
   * distinct from an empty array, so the console can say "not yours / not
   * found" rather than showing a blank timeline for a record that exists.
   */
  listStatusHistory(input: ReadOneInput): Promise<readonly StatusHistoryEntry[] | null>;
}
