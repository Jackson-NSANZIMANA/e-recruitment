// ══════════════════════════════════════════════════════════════════
// identity-service — Citizen document upload (BUILD-002)
//
//   POST /v1/applicants/me/applications/documents   (multipart/form-data)
//
// SESSION-authenticated like every /me route. The subject is DERIVED from the
// opaque session; a client-supplied `applicantId` part is REFUSED (an ignored
// authorization field is a control the caller thinks exists). The multipart
// body is parsed with hard structural limits, then re-built from scratch for
// document-forensics-service, so nothing the client composed beyond
// { applicationId, documentType, file } is forwarded.
//
// 201 carries { documentId, documentType } — never a lane, score or flag.
// ══════════════════════════════════════════════════════════════════

import {
  HttpError,
  parseMultipartFormData,
  rawContentType,
  type HttpResult,
  type Route,
} from '@usrp/shared-http';
import type { ApplicantAuthService } from '../../application/applicant-auth.service.js';
import type { DocumentUploadGateway } from '../../ports/document-upload-gateway.js';
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
          throw new HttpError(503, 'DOCUMENTS_UNAVAILABLE', 'Document upload is not available.');
        }

        const form = parseMultipartFormData(await ctx.rawBody(), rawContentType(ctx.headers), {
          maxParts: MAX_PARTS,
          maxFiles: 1,
          maxFieldBytes: MAX_FIELD_BYTES,
        });
        if (form.fields.has('applicantId')) {
          throw new HttpError(400, 'FORBIDDEN_FIELD', 'Field "applicantId" is not accepted.');
        }
        const applicationId = form.fields.get('applicationId');
        if (applicationId === undefined || !UUID_RE.test(applicationId)) {
          throw new HttpError(400, 'INVALID_REQUEST', 'Field "applicationId" must be a UUID.');
        }
        const documentType = form.fields.get('documentType');
        if (documentType === undefined || !DOCUMENT_TYPE_RE.test(documentType)) {
          throw new HttpError(400, 'INVALID_REQUEST', 'Field "documentType" is required.');
        }
        const file = form.files[0];
        if (file === undefined || file.fieldName !== 'file') {
          throw new HttpError(400, 'MISSING_FILE', 'A file part named "file" is required.');
        }
        if (file.bytes.length === 0) {
          throw new HttpError(400, 'EMPTY_FILE', 'The uploaded file is empty.');
        }
        if (file.bytes.length > options.maxFileSizeBytes) {
          throw new HttpError(413, 'FILE_TOO_LARGE', 'The file is too large.');
        }
        if (!allowed.has(file.contentType)) {
          throw new HttpError(422, 'UNSUPPORTED_FILE_TYPE', 'That file type is not accepted.');
        }

        const result = await documents.uploadForApplicant(applicantId, {
          applicationId,
          documentType,
          file: { bytes: file.bytes, contentType: file.contentType, filename: file.filename },
        });
        switch (result.kind) {
          case 'UPLOADED':
            return {
              status: 201,
              body: { status: 'UPLOADED', documentId: result.documentId, documentType: result.documentType },
            };
          case 'REFUSED':
            return { status: result.httpStatus, body: { status: 'REFUSED', error: result.code } };
          case 'DEPENDENCY_UNAVAILABLE':
            return {
              status: 502,
              body: { status: 'DEPENDENCY_UNAVAILABLE', reason: 'A dependent service is unavailable.' },
            };
        }
      },
    },
  ];
}
