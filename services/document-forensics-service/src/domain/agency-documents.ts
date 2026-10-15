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

import { AGENCY_DOCUMENT_TYPES } from '@usrp/shared-types';
import type { Agency, DocumentType } from '@usrp/shared-types';

// The set itself now lives in @usrp/shared-types (one source for forensics,
// application-service policy validation and venue verification).
export { AGENCY_DOCUMENT_TYPES };

export function isDocumentTypeSupported(agency: Agency, documentType: DocumentType): boolean {
  return AGENCY_DOCUMENT_TYPES[agency].has(documentType);
}
