// ══════════════════════════════════════════════════════════════════
// identity-service — DocumentUploadGateway port (BUILD-002)
//
// The citizen's document door. document-forensics-service accepts uploads
// only under a SYSTEM token and trusts the `applicantId` it is handed, so
// the browser can never reach it directly: identity-service authenticates
// the opaque session, derives the subject itself, and forwards on the
// citizen's behalf — exactly the posture of the submit bridge (ADR-027).
//
// The verdict (lane, score, flags) and keyed content HMAC are NEVER relayed:
// either handed to the uploader would disclose internal forensic state. Only
// the document identifiers, validated revision, and closed refusal vocabulary
// (including D8's two closed-review reasons) cross this port.
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

/** D8: closed explanation for why a document slot cannot be replaced. */
export const DOCUMENT_REVIEW_CLOSED_REASONS = ['HUMAN_REVIEWED', 'CASE_ADVANCED'] as const;
export type DocumentReviewClosedReason = (typeof DOCUMENT_REVIEW_CLOSED_REASONS)[number];

export function isDocumentReviewClosedReason(value: unknown): value is DocumentReviewClosedReason {
  return DOCUMENT_REVIEW_CLOSED_REASONS.some((reason) => reason === value);
}

export type DocumentUploadResult =
  | {
      readonly kind: 'UPLOADED';
      readonly documentId: string;
      readonly documentType: string;
      /** Positive safe integer, validated at the HTTP gateway boundary (D8). */
      readonly revision: number;
    }
  | {
      readonly kind: 'REFUSED';
      readonly httpStatus: number;
      readonly code: Exclude<DocumentRefusal, 'DOCUMENT_REVIEW_CLOSED'>;
    }
  | {
      readonly kind: 'REFUSED';
      readonly httpStatus: 409;
      readonly code: 'DOCUMENT_REVIEW_CLOSED';
      readonly reason: DocumentReviewClosedReason;
    }
  /** Nothing was stored (object store/forensics down, or token refused). */
  | { readonly kind: 'DEPENDENCY_UNAVAILABLE' };

export interface DocumentUploadGateway {
  uploadForApplicant(applicantId: string, input: DocumentUploadInput): Promise<DocumentUploadResult>;
}
