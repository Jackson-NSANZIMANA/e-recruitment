// ══════════════════════════════════════════════════════════════════
// identity-service — Citizen document upload (BUILD-002)
//
//   POST /v1/applicants/me/applications/documents   (multipart/form-data)
//
// D7: every answer this route gives is built from the ONE shared document-door
// vocabulary (@usrp/shared-types DOCUMENT_DOOR_CODES), which is also what
// document-forensics-service renders from and what the gateway classifies from.
// An unknown document type is refused HERE, at 422, before a round trip and a
// ClamAV scan are spent on a document type that agency never accepts.
//
// SESSION-authenticated like every /me route. The subject is DERIVED from the
// opaque session; a client-supplied `applicantId` part is REFUSED (an ignored
// authorization field is a control the caller thinks exists). The multipart
// body is parsed with hard structural limits, then re-built from scratch for
// document-forensics-service, so nothing the client composed beyond
// { applicationId, documentType, file } is forwarded.
//
// 201 carries { status, documentId, documentType, revision } — never a lane,
// score, flag, keyed digest or revision history. A closed-review 409 carries
// only the approved reason HUMAN_REVIEWED or CASE_ADVANCED.
// ══════════════════════════════════════════════════════════════════

import {
  HttpError,
  parseMultipartFormData,
  rawContentType,
  type HttpResult,
  type Route,
} from '@usrp/shared-http';
import { DOCUMENT_DOOR_CODES, isKnownDocumentType, type DocumentDoorCode } from '@usrp/shared-types';
import { logError } from '@usrp/shared-logging';
import type { ApplicantAuthService } from '../../application/applicant-auth.service.js';
import {
  isDocumentReviewClosedReason,
  type DocumentUploadGateway,
} from '../../ports/document-upload-gateway.js';
import { authHeader, authenticate } from './applicant-auth.controller.js';

export const ME_DOCUMENTS_PATH = '/v1/applicants/me/applications/documents';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOCUMENT_TYPE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const MULTIPART_FRAMING_BUDGET_BYTES = 8 * 1024;
const MAX_FIELD_BYTES = 1024;
const MAX_PARTS = 6;

export interface DocumentRouteOptions {
  /** FORENSICS_MAX_FILE_SIZE_MB, in bytes. */
  readonly maxFileSizeBytes: number;
  readonly allowedMediaTypes: readonly string[];
}

/** Throw the door's error for a shared code, at the status that code declares. */
function doorError(code: DocumentDoorCode, detail: string): HttpError {
  return new HttpError(DOCUMENT_DOOR_CODES[code].status, code, detail);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function dependencyUnavailable(): HttpResult {
  return {
    status: 502,
    body: { status: 'DEPENDENCY_UNAVAILABLE', reason: 'A dependent service is unavailable.' },
  };
}

export function applicantDocumentRoutes(
  service: ApplicantAuthService,
  documents: DocumentUploadGateway | null,
  options: DocumentRouteOptions,
): Route[] {
  const allowed = new Set(options.allowedMediaTypes.map((t) => t.toLowerCase()));
  return [
    {
      method: 'POST',
      path: ME_DOCUMENTS_PATH,
      maxBodyBytes: options.maxFileSizeBytes + MULTIPART_FRAMING_BUDGET_BYTES,
      handler: async (ctx): Promise<HttpResult> => {
        const applicantId = await authenticate(authHeader(ctx.headers['authorization']), service);
        if (documents === null) {
          throw doorError('DOCUMENTS_UNAVAILABLE', 'Document upload is not available.');
        }

        const form = parseMultipartFormData(await ctx.rawBody(), rawContentType(ctx.headers), {
          maxParts: MAX_PARTS,
          maxFiles: 1,
          maxFieldBytes: MAX_FIELD_BYTES,
        });
        if (form.fields.has('applicantId')) {
          throw doorError('FORBIDDEN_FIELD', 'Field "applicantId" is not accepted.');
        }
        const applicationId = form.fields.get('applicationId');
        if (applicationId === undefined || !UUID_RE.test(applicationId)) {
          throw doorError('INVALID_REQUEST', 'Field "applicationId" must be a UUID.');
        }
        const documentType = form.fields.get('documentType');
        if (documentType === undefined || !DOCUMENT_TYPE_RE.test(documentType)) {
          throw doorError('INVALID_REQUEST', 'Field "documentType" is required.');
        }
        // The word must be a document type USRP models at all. Which AGENCY then
        // accepts it is the owning service's call (the agency comes from
        // ownership of the application, never from this request) — but a type no
        // agency models is refused here, as a caller error, not upstream.
        if (!isKnownDocumentType(documentType)) {
          throw doorError('UNSUPPORTED_DOCUMENT_TYPE', 'That document type is not accepted.');
        }
        const file = form.files[0];
        if (file === undefined || file.fieldName !== 'file') {
          throw doorError('MISSING_FILE', 'A file part named "file" is required.');
        }
        if (file.bytes.length === 0) {
          throw doorError('EMPTY_FILE', 'The uploaded file is empty.');
        }
        if (file.bytes.length > options.maxFileSizeBytes) {
          throw doorError('FILE_TOO_LARGE', 'The file is too large.');
        }
        if (!allowed.has(file.contentType)) {
          throw doorError('UNSUPPORTED_FILE_TYPE', 'That file type is not accepted.');
        }

        const result = await documents.uploadForApplicant(applicantId, {
          applicationId,
          documentType,
          file: { bytes: file.bytes, contentType: file.contentType, filename: file.filename },
        });
        switch (result.kind) {
          case 'UPLOADED': {
            const invalidFields: string[] = [];
            if (typeof result.documentId !== 'string' || !UUID_RE.test(result.documentId)) invalidFields.push('documentId');
            if (result.documentType !== documentType) invalidFields.push('documentType');
            if (!isPositiveSafeInteger(result.revision)) invalidFields.push('revision');
            if (invalidFields.length > 0) {
              logError('document_door_contract_drift', {
                stage: 'identity_controller',
                code: 'INVALID_UPLOAD_RESULT',
                fields: invalidFields,
              });
              return dependencyUnavailable();
            }
            return {
              status: 201,
              body: {
                status: 'UPLOADED',
                documentId: result.documentId,
                documentType: result.documentType,
                revision: result.revision,
              },
            };
          }
          case 'REFUSED':
            if (result.code === 'DOCUMENT_REVIEW_CLOSED') {
              const closedStatus: unknown = result.httpStatus;
              const closedReason: unknown = result.reason;
              if (closedStatus !== 409 || !isDocumentReviewClosedReason(closedReason)) {
                logError('document_door_contract_drift', {
                  stage: 'identity_controller',
                  code: 'DOCUMENT_REVIEW_CLOSED',
                  reason: closedReason === undefined ? 'MISSING' : 'UNRECOGNIZED',
                });
                return dependencyUnavailable();
              }
              return {
                status: 409,
                body: { status: 'REFUSED', error: result.code, reason: closedReason },
              };
            }
            return { status: result.httpStatus, body: { status: 'REFUSED', error: result.code } };
          case 'DEPENDENCY_UNAVAILABLE':
            return dependencyUnavailable();
        }
      },
    },
  ];
}
