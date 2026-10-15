// ══════════════════════════════════════════════════════════════════
// application-service — DocumentChecklistRepository port (ADR-032)
//
// The facts the advisory checklist is computed from, read in ONE transaction
// so the gate verdicts, the bound policy list and the documents are mutually
// consistent. Two scopes, never mixed:
//   • officer  — the officer's OWN agency DB role (cross-agency ⇒ not found);
//   • citizen  — the system role, but only for an application whose
//                applicant_id is the session-derived subject.
// ══════════════════════════════════════════════════════════════════

import type { Agency, ApplicationCategory, ApplicationStatus, DocumentType } from '@usrp/shared-types';
import type { DbRole } from '@usrp/shared-auth';
import type { GateVerdicts, StoredDocument } from '../domain/document-requirements.js';

export interface ChecklistFacts {
  readonly agency: Agency;
  readonly category: ApplicationCategory;
  readonly status: ApplicationStatus;
  /** The bound policy version's list for this category; undefined ⇒ none bound. */
  readonly policyRequired: readonly DocumentType[] | undefined;
  readonly gates: GateVerdicts;
  readonly documents: readonly StoredDocument[];
}

export interface OfficerScope {
  readonly agency: Agency;
  readonly dbRole: DbRole;
}

export interface VenueVerificationInput {
  readonly agency: Agency;
  readonly dbRole: DbRole;
  readonly officerId: string;
  readonly applicationId: string;
  readonly documentType: DocumentType;
}

export type VenueVerificationWrite = 'RECORDED' | 'ALREADY_RECORDED';

export interface DocumentChecklistRepository {
  loadForOfficer(scope: OfficerScope, applicationId: string): Promise<ChecklistFacts | null>;
  loadForApplicant(applicantId: string, applicationId: string): Promise<ChecklistFacts | null>;
  /** Idempotent: a second sighting of the same type is ALREADY_RECORDED, not a new row. */
  recordVenueVerification(input: VenueVerificationInput): Promise<VenueVerificationWrite>;
}
