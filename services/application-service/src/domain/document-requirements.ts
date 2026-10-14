// ══════════════════════════════════════════════════════════════════
// application-service — Document requirements (pure domain)
//
// WHAT AN APPLICATION MUST SHOW, AND HOW EACH ITEM CAN BE SATISFIED.
//
// Two sources of "required", in strict order:
//   1. the POLICY VERSION bound to the application (BUILD-001/002) —
//      `requiredDocumentTypes` authored by the campaign's authorised officer
//      and hashed, so a later amendment cannot rewrite an earlier applicant's
//      list;
//   2. REQUIRED_DOCUMENTS in @usrp/shared-types — the ground truth transcribed
//      from the three agencies' official announcements — for campaigns that
//      have no policy version (published before BUILD-001, or walk-in).
// A policy list, when present, WINS; it is never merged with the table.
//
// HOW AN ITEM IS SATISFIED. The official announcements say candidates "present
// themselves with" / "bring" the documents (RNP, RCS), and RDF admits walk-ins
// with none pre-registered. So a digital upload is ONE way to satisfy an item,
// not the only way, and this module therefore never answers "may proceed" — it
// answers "what is the state of each item", and leaves the consequence (advisory
// vs. blocking, and at which stage) to a policy-owner decision (ADR-032).
//
//   API_VERIFIED       a registry has positively confirmed the underlying fact
//                      (NIDA identity; NESA/HEC academic; RIB criminal). Only
//                      derived from the application's REAL gate verdicts, never
//                      from the document type alone.
//   UPLOADED_CLEARED   a stored document passed the scan and forensics GREEN,
//                      or a human reviewer cleared an amber/red hold.
//   UNDER_REVIEW       uploaded; awaiting forensics or a human decision.
//   REJECTED           uploaded and refused (RED, or a human REJECT).
//   MISSING            nothing satisfies it (yet) — present at the venue, or
//                      upload.
//
// PURE and total: no I/O, no clock, no throw.
// ══════════════════════════════════════════════════════════════════

import {
  REQUIRED_DOCUMENTS,
  type AcademicEligibilityStatus,
  type ApplicationCategory,
  type CriminalClearanceStatus,
  type DocumentType,
} from '@usrp/shared-types';
import { academicPathForCategory } from './academic-input.js';

/** The registry that can verify the fact a document merely evidences. */
export type VerifyingAuthority = 'NIDA' | 'NESA' | 'HEC' | 'RIB';

/**
 * Document types whose underlying FACT a government registry can confirm.
 *
 * Deliberately conservative: a registry verifies the fact, not the paper. A
 * notarised copy, a sector-issued conduct certificate, the signed application
 * form, a birth/celibacy certificate and a physician's certificate have no
 * registry in this platform, so they can only be uploaded or presented.
 * Whether an API confirmation WAIVES the paper copy is a policy decision.
 */
export const REGISTRY_FOR_DOCUMENT: Readonly<Record<DocumentType, VerifyingAuthority | null>> = {
  NATIONAL_ID: 'NIDA',
  OLEVEL_CERTIFICATE: 'NESA',
  ALEVEL_CERTIFICATE: 'NESA',
  DEGREE_DIPLOMA_COPY: 'HEC',
  DEGREE_DIPLOMA_NOTARIZED: null,
  NON_CONVICTION_CERTIFICATE: 'RIB',
  GOOD_CONDUCT_CERTIFICATE: null,
  APPLICATION_FORM_WITH_PHOTO: null,
  BIRTH_CERTIFICATE: null,
  CELIBACY_CERTIFICATE: null,
  MEDICAL_CERTIFICATE_GOVT: null,
};

export type DocumentSatisfaction =
  | 'API_VERIFIED'
  | 'UPLOADED_CLEARED'
  | 'UNDER_REVIEW'
  | 'REJECTED'
  | 'MISSING';

/** Where the required list came from — audit evidence, never inferred later. */
export type RequirementSource = 'POLICY_VERSION' | 'GROUND_TRUTH_TABLE';

export interface ResolvedRequirements {
  readonly source: RequirementSource;
  readonly types: readonly DocumentType[];
}

/** The slice of an application row the checklist needs. All real gate verdicts. */
export interface GateVerdicts {
  readonly identityVerified: boolean;
  readonly academicStatus: AcademicEligibilityStatus;
  readonly criminalStatus: CriminalClearanceStatus;
}

/** The slice of a stored document row the checklist needs. */
export interface StoredDocument {
  readonly documentType: DocumentType;
  readonly forensicsLane: 'GREEN' | 'AMBER' | 'RED' | null;
  readonly verifiedViaApi: boolean;
  readonly humanReviewDecision: 'CLEAR' | 'REJECT' | null;
  readonly virusScanPassed: boolean;
}

export interface ChecklistItem {
  readonly documentType: DocumentType;
  readonly satisfaction: DocumentSatisfaction;
  /** The registry that would verify it, when one exists (even if not yet done). */
  readonly registry: VerifyingAuthority | null;
}

export interface DocumentChecklist {
  readonly source: RequirementSource;
  readonly items: readonly ChecklistItem[];
  /** Every item is API_VERIFIED or UPLOADED_CLEARED. Advisory — see header. */
  readonly complete: boolean;
}

/**
 * The required list for an application. `policyRequired` is the bound policy
 * version's list for THIS category (undefined/empty-by-absence ⇒ fall back).
 * An explicitly EMPTY policy list is respected: the authorised officer chose
 * "no documents", which is not the same as "no policy".
 */
export function resolveRequiredDocuments(
  category: ApplicationCategory,
  policyRequired: readonly DocumentType[] | undefined,
): ResolvedRequirements {
  if (policyRequired !== undefined) {
    return { source: 'POLICY_VERSION', types: [...new Set(policyRequired)].sort() };
  }
  const table = (REQUIRED_DOCUMENTS as Readonly<Record<string, readonly DocumentType[]>>)[category];
  return { source: 'GROUND_TRUTH_TABLE', types: table === undefined ? [] : [...table].sort() };
}

/** Does a verified registry result stand for this registry on THIS application? */
function registryConfirmed(
  authority: VerifyingAuthority,
  category: ApplicationCategory,
  gates: GateVerdicts,
): boolean {
  switch (authority) {
    case 'NIDA':
      return gates.identityVerified;
    case 'RIB':
      return gates.criminalStatus === 'CLEARED';
    case 'NESA':
    case 'HEC':
      // The category fixes WHICH registry verifies its qualification; the other
      // registry's gate says nothing about this applicant's certificate.
      return academicPathForCategory(category) === authority && gates.academicStatus === 'ELIGIBLE';
  }
}

function satisfactionOf(stored: readonly StoredDocument[]): DocumentSatisfaction {
  // Best evidence wins across re-uploads of the same type.
  const cleared = stored.some(
    (d) =>
      d.verifiedViaApi ||
      d.humanReviewDecision === 'CLEAR' ||
      (d.forensicsLane === 'GREEN' && d.virusScanPassed && d.humanReviewDecision !== 'REJECT'),
  );
  if (cleared) return 'UPLOADED_CLEARED';
  const pending = stored.some(
    (d) => d.humanReviewDecision === null && d.forensicsLane !== 'RED',
  );
  if (pending) return 'UNDER_REVIEW';
  if (stored.length > 0) return 'REJECTED';
  return 'MISSING';
}

/** The state of every required item for one application. */
export function evaluateDocumentChecklist(
  category: ApplicationCategory,
  requirements: ResolvedRequirements,
  gates: GateVerdicts,
  documents: readonly StoredDocument[],
): DocumentChecklist {
  const items = requirements.types.map((documentType): ChecklistItem => {
    const registry = REGISTRY_FOR_DOCUMENT[documentType];
    if (registry !== null && registryConfirmed(registry, category, gates)) {
      return { documentType, satisfaction: 'API_VERIFIED', registry };
    }
    const stored = documents.filter((d) => d.documentType === documentType);
    return { documentType, satisfaction: satisfactionOf(stored), registry };
  });
  return {
    source: requirements.source,
    items,
    complete: items.every(
      (i) => i.satisfaction === 'API_VERIFIED' || i.satisfaction === 'UPLOADED_CLEARED',
    ),
  };
}
