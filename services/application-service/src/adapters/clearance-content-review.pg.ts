// ══════════════════════════════════════════════════════════════════
// application-service — may an open criminal review let the exam go ahead?
//
// ONE reading, shared by both writers of an application's status (the vetting
// projection and the officer's adjudication), so the two can never place the
// same row differently. Two kinds of criminal review leave an officer only a
// DECISION to record, with nothing the applicant can still fix:
//
//   • CERTIFICATE CONTENT — the latest Irembo verification (rls/0040, written by
//     background-vetting-service BEFORE it publishes its verdict) is REVIEW with
//     exactly CLEARANCE_CONTENT_REVIEW: the registry proved the certificate
//     authentic, in force, of an accepted type, in the window and bound to this
//     applicant; an officer reads what it says (ADR-048 §4).
//   • AGENCY RECORD CHECK — the category asks for NO certificate (RNP, as
//     printed: the required documents, resolved exactly as the checklist resolves
//     them, do not include NON_CONVICTION_CERTIFICATE) and no verification exists:
//     the agency checks its own records and an officer records the result
//     (owner decision 2026-11-15, ADR-033 amendment).
//
// Any other reason (an identity doubt), or a certificate the applicant was asked
// for and has not given, is NOT this.
//
// Readable by usrp_system_service (the projection) and the agency officer role
// (adjudication); closed codes only, never a name, date or number.
// ══════════════════════════════════════════════════════════════════

import { sql, type SqlTransaction } from '@usrp/shared-database';
import type { ApplicationCategory, DocumentType } from '@usrp/shared-types';
import { resolveRequiredDocuments } from '../domain/document-requirements.js';

export const CLEARANCE_CONTENT_REVIEW = 'CLEARANCE_CONTENT_REVIEW';
const CERTIFICATE: DocumentType = 'NON_CONVICTION_CERTIFICATE';

/** PURE. The latest verification's outcome and reasons → content-only review? */
export function isContentReviewOnly(outcome: string | null, reasons: readonly string[] | null): boolean {
  return outcome === 'REVIEW' && reasons !== null && reasons.length === 1 && reasons[0] === CLEARANCE_CONTENT_REVIEW;
}

/** A policy list is honoured only if it is a JSON array of strings (as the checklist reads it). */
function policyList(value: unknown): readonly DocumentType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((v): v is string => typeof v === 'string') ? (value as DocumentType[]) : undefined;
}

/** PURE. Does this application's category ask the citizen for a criminal-record certificate? */
export function certificateRequired(category: ApplicationCategory, policyRequired: unknown): boolean {
  return resolveRequiredDocuments(category, policyList(policyRequired)).types.includes(CERTIFICATE);
}

interface ReviewFacts {
  readonly category: ApplicationCategory;
  readonly required: unknown;
  readonly outcome: string | null;
  readonly review_reasons: string[] | null;
}

async function readFacts(tx: SqlTransaction, schemaName: string, applicationId: string): Promise<ReviewFacts | undefined> {
  const schema = sql(schemaName);
  const rows = await tx<ReviewFacts[]>`
    SELECT a.category::text AS category,
           pv.policy_document -> (a.category::text) -> 'requiredDocumentTypes' AS required,
           v.outcome, v.review_reasons
    FROM ${schema}.applications a
    LEFT JOIN public_core.campaign_policy_versions pv ON pv.id = a.policy_version_id
    LEFT JOIN LATERAL (
      SELECT outcome, review_reasons
      FROM ${schema}.clearance_certificate_verifications
      WHERE application_id = a.id
      ORDER BY verified_at DESC, id DESC
      LIMIT 1
    ) v ON true
    WHERE a.id = ${applicationId}
  `;
  return rows[0];
}

/** Inside the caller's transaction and role: does the open criminal review let the exam go ahead? */
export async function criminalReviewAdmitsExam(tx: SqlTransaction, schemaName: string, applicationId: string): Promise<boolean> {
  const facts = await readFacts(tx, schemaName, applicationId);
  if (facts === undefined) return false;
  if (facts.outcome !== null) return isContentReviewOnly(facts.outcome, facts.review_reasons);
  return !certificateRequired(facts.category, facts.required);
}

/**
 * Inside the caller's transaction and role: is this a category whose criminal check
 * is the agency's own record check (no certificate asked of the citizen)?
 */
export async function agencyRecordCheckApplies(tx: SqlTransaction, schemaName: string, applicationId: string): Promise<boolean> {
  const facts = await readFacts(tx, schemaName, applicationId);
  return facts !== undefined && facts.outcome === null && !certificateRequired(facts.category, facts.required);
}
