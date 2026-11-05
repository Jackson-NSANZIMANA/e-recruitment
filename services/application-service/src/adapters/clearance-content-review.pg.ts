// ══════════════════════════════════════════════════════════════════
// application-service — "only the certificate's content is left to read"
//
// ONE reading, shared by both writers of an application's status (the vetting
// projection and the officer's adjudication), so the two can never place the
// same row differently. The fact comes from the latest Irembo verification
// (rls/0040, written by background-vetting-service BEFORE it publishes its
// verdict): outcome REVIEW whose ONLY reason is CLEARANCE_CONTENT_REVIEW. The
// registry has then already proved the certificate authentic, in force, of an
// accepted type, within the policy's window and bound to this applicant
// (ADR-048 §2.5); what remains is an officer reading what it says. Any other
// reason (an identity doubt) or no verification at all is NOT this.
//
// Readable by usrp_system_service (the projection) and the agency officer role
// (adjudication); closed codes only, never a name, date or number.
// ══════════════════════════════════════════════════════════════════

import { sql, type SqlTransaction } from '@usrp/shared-database';

export const CLEARANCE_CONTENT_REVIEW = 'CLEARANCE_CONTENT_REVIEW';

/** PURE. The latest verification's outcome and reasons → content-only review? */
export function isContentReviewOnly(outcome: string | null, reasons: readonly string[] | null): boolean {
  return outcome === 'REVIEW' && reasons !== null && reasons.length === 1 && reasons[0] === CLEARANCE_CONTENT_REVIEW;
}

/** Inside the caller's transaction and role: is the open criminal review about content only? */
export async function criminalContentReviewOnly(tx: SqlTransaction, schemaName: string, applicationId: string): Promise<boolean> {
  const rows = await tx<{ outcome: string; review_reasons: string[] | null }[]>`
    SELECT outcome, review_reasons
    FROM ${sql(schemaName)}.clearance_certificate_verifications
    WHERE application_id = ${applicationId}
    ORDER BY verified_at DESC, id DESC
    LIMIT 1
  `;
  const latest = rows[0];
  return latest === undefined ? false : isContentReviewOnly(latest.outcome, latest.review_reasons);
}
