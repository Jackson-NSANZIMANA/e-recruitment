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

export interface DocumentUploadInput {
  readonly applicationId: string;
  readonly documentType: string;
  readonly file: {
    readonly bytes: Buffer;
    readonly contentType: string;
    readonly filename: string;
  };
}

/** Closed set of refusal codes safe to show a citizen. */
export type DocumentRefusal =
  | 'APPLICATION_NOT_FOUND'
  | 'NOT_ACCEPTING_DOCUMENTS'
  | 'UNSUPPORTED_DOCUMENT_TYPE'
  | 'UNSUPPORTED_FILE_CONTENT'
  | 'CONTENT_TYPE_MISMATCH'
  | 'DOCUMENT_REJECTED_MALWARE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FILE_TYPE';

export type DocumentUploadResult =
  | { readonly kind: 'UPLOADED'; readonly documentId: string; readonly documentType: string }
  | { readonly kind: 'REFUSED'; readonly httpStatus: number; readonly code: DocumentRefusal }
  /** Nothing was stored (scanner/object store/forensics down, or token refused). */
  | { readonly kind: 'DEPENDENCY_UNAVAILABLE' };

export interface DocumentUploadGateway {
  uploadForApplicant(applicantId: string, input: DocumentUploadInput): Promise<DocumentUploadResult>;
}
