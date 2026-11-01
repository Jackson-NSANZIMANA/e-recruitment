// ══════════════════════════════════════════════════════════════════
// identity-service — DocumentUploadGateway port (BUILD-002)
//
// The citizen's document door. document-forensics-service accepts uploads
// only under a SYSTEM token and trusts the `applicantId` it is handed, so
// the browser can never reach it directly: identity-service authenticates
// the opaque session, derives the subject itself, and forwards on the
// citizen's behalf — exactly the posture of the submit bridge (ADR-027).
//
// The verdict (lane, score, flags) is NEVER relayed: a score handed to the
// uploader is a forgery-tuning oracle. Only the identifiers and a closed
// set of refusal codes cross this port.
// ══════════════════════════════════════════════════════════════════

import type { DocumentDoorCode } from '@usrp/shared-types';

export interface DocumentUploadInput {
  readonly applicationId: string;
  readonly documentType: string;
  readonly file: {
    readonly bytes: Buffer;
    readonly contentType: string;
    readonly filename: string;
  };
}

/**
 * Closed set of refusal codes safe to show a citizen — DERIVED from the one
 * shared vocabulary (@usrp/shared-types `DOCUMENT_DOOR_RELAY`, D7), never
 * retyped here. The previous hand-written union omitted codes the door really
 * answers with, so they were classified as "the service is down" and the citizen
 * was told to retry a door that would never open.
 *
 * `status` comes with the code: identity relays the citizen-meaningful status the
 * shared table declares, not the upstream service's raw one.
 */
export type DocumentRefusal = Extract<
  DocumentDoorCode,
  | 'APPLICATION_NOT_FOUND'
  | 'NOT_ACCEPTING_DOCUMENTS'
  | 'DOCUMENT_REVIEW_CLOSED'
  | 'UNSUPPORTED_DOCUMENT_TYPE'
  | 'UNSUPPORTED_FILE_CONTENT'
  | 'CONTENT_TYPE_MISMATCH'
  | 'DOCUMENT_REJECTED_MALWARE'
  | 'DOCUMENT_REFUSED'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'SCANNER_UNAVAILABLE'
>;

export type DocumentUploadResult =
  | { readonly kind: 'UPLOADED'; readonly documentId: string; readonly documentType: string }
  | { readonly kind: 'REFUSED'; readonly httpStatus: number; readonly code: DocumentRefusal }
  /** Nothing was stored (object store/forensics down, or token refused). */
  | { readonly kind: 'DEPENDENCY_UNAVAILABLE' };

export interface DocumentUploadGateway {
  uploadForApplicant(applicantId: string, input: DocumentUploadInput): Promise<DocumentUploadResult>;
}
