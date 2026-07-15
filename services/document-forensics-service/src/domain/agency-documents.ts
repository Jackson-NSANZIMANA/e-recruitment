// ══════════════════════════════════════════════════════════════════
// document-forensics-service — Per-agency accepted document types
//
// The three agencies model documents DIFFERENTLY (same class of genuine
// divergence as the Slice-4 medical finding): each ops schema has its OWN
// document_type enum — e.g. CELIBACY_CERTIFICATE exists only in rcs_ops,
// OLEVEL_CERTIFICATE only in rdf_ops. These sets mirror the LIVE enums
// (verified 2026-07-14); a documentType outside the owning agency's set is
// rejected as a clean UNSUPPORTED_DOCUMENT_TYPE outcome rather than leaking
// a raw enum-cast DB error.
// ══════════════════════════════════════════════════════════════════

import type { Agency, DocumentType } from '@usrp/shared-types';

export const AGENCY_DOCUMENT_TYPES: Readonly<Record<Agency, ReadonlySet<DocumentType>>> = {
  RDF: new Set<DocumentType>([
    'NATIONAL_ID',
    'OLEVEL_CERTIFICATE',
    'ALEVEL_CERTIFICATE',
    'DEGREE_DIPLOMA_COPY',
    'GOOD_CONDUCT_CERTIFICATE',
    'NON_CONVICTION_CERTIFICATE',
  ]),
  RNP: new Set<DocumentType>([
    'NATIONAL_ID',
    'APPLICATION_FORM_WITH_PHOTO',
    'ALEVEL_CERTIFICATE',
    'DEGREE_DIPLOMA_COPY',
    'GOOD_CONDUCT_CERTIFICATE',
  ]),
  RCS: new Set<DocumentType>([
    'NATIONAL_ID',
    'APPLICATION_FORM_WITH_PHOTO',
    'BIRTH_CERTIFICATE',
    'ALEVEL_CERTIFICATE',
    'DEGREE_DIPLOMA_NOTARIZED',
    'GOOD_CONDUCT_CERTIFICATE',
    'NON_CONVICTION_CERTIFICATE',
    'CELIBACY_CERTIFICATE',
    'MEDICAL_CERTIFICATE_GOVT',
  ]),
};

export function isDocumentTypeSupported(agency: Agency, documentType: DocumentType): boolean {
  return AGENCY_DOCUMENT_TYPES[agency].has(documentType);
}
