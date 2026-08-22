// ══════════════════════════════════════════════════════════════════
// document-forensics-service — Document upload ingress (HTTP adapter)
//
// POST /v1/documents/upload — multipart/form-data, SYSTEM-token only.
//
// System-token, exactly like ADR-020's withdraw-own: the caller is the edge
// (citizen-bff), which authenticated the citizen's opaque session and acts on
// their behalf. An OFFICER token is refused with 403 — this door carries the
// citizen's own authority over their own application, and must never become an
// unaudited path for an officer to inject documents into a case they review.
//
// ── THE RESPONSE WITHHOLDS THE VERDICT, DELIBERATELY ─────────────────
//
// 201 carries { documentId, documentType } — no lane, no score, no flags. This
// route is reached from the citizen portal, and a forensics score handed to the
// person who uploaded the file is a FORGERY-TUNING ORACLE: edit, re-upload,
// watch the number move, repeat until GREEN. Verdicts belong to the officer
// reads (by-id, amber queue), where the audience is the reviewer rather than
// the author.
//
// MALWARE IS THE ONE EXCEPTION and is reported plainly. A binary antivirus
// verdict teaches a forger nothing, and silently accepting an infected file the
// citizen believes was received is unusable UX for a legal process.
//
// ── TWO BODY CAPS, BOTH NEEDED ───────────────────────────────
//
// Route.maxBodyBytes = file cap + multipart framing budget bounds what the
// SOCKET may spend (P0 made the cap opt-in per route for precisely this one, so
// no other endpoint inherits a 10 MB DoS budget). The separate file-length
// check enforces the CONTRACT: without it a caller could spend the whole body
// budget on framing plus legal-looking junk parts and never send an oversized file.
//
// The client's filename is validated and then IGNORED. The object key is
// derived from closed-set inputs (domain/object-key.ts) — a filename-derived
// key is a path traversal and a write-into-someone-else's-record primitive.
// ══════════════════════════════════════════════════════════════════

import {
  HttpError,
  parseMultipartFormData,
  rawContentType,
  type HttpResult,
  type MultipartForm,
  type Route,
} from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import type { DocumentType } from '@usrp/shared-types';
import { AGENCY_DOCUMENT_TYPES } from '../../domain/agency-documents.js';
import { DocumentEnvelopeError } from '../../domain/document-envelope.js';
import { ForensicsPersistenceError } from '../../domain/forensics.errors.js';
import { ObjectStoreUnavailableError } from '../../ports/object-store.js';
import type {
  UploadDocumentOutcome,
  UploadDocumentService,
} from '../../application/upload-document.service.js';

export const UPLOAD_DOCUMENT_PATH = '/v1/documents/upload';

/** Headroom for boundaries, part headers and the three text fields. */
const MULTIPART_FRAMING_BUDGET_BYTES = 8 * 1024;

const FILE_FIELD = 'file';
const MAX_FILENAME_LENGTH = 255;
const MAX_FIELD_BYTES = 4 * 1024;
const MAX_PARTS = 8;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Control characters in a filename are a log-injection / terminal-escape vector. */
const CONTROL_CHAR_RE = /[-\u001f\u007f]/;

/**
 * Every document type any agency models — DERIVED from the per-agency sets, not
 * retyped. The per-agency check happens in the use case once the agency is known
 * from ownership; this is only the "is that a word at all" gate. A third
 * hand-maintained copy of this list is how one agency's enum silently drifts.
 */
const KNOWN_DOCUMENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(AGENCY_DOCUMENT_TYPES).flatMap((types) => [...types]),
);

export interface UploadRouteOptions {
  /** FORENSICS_MAX_FILE_SIZE_MB, in bytes. */
  readonly maxFileSizeBytes: number;
  /** FORENSICS_ALLOWED_MIME_TYPES. */
  readonly allowedMediaTypes: readonly string[];
}

export function uploadDocumentRoute(
  service: UploadDocumentService,
  verify: AuthVerifier,
  options: UploadRouteOptions,
): Route {
  const allowed = new Set(options.allowedMediaTypes.map((type) => type.toLowerCase()));

  return {
    method: 'POST',
    path: UPLOAD_DOCUMENT_PATH,
    // The ONLY route in the system permitted to spend this many bytes.
    maxBodyBytes: options.maxFileSizeBytes + MULTIPART_FRAMING_BUDGET_BYTES,
    handler: withAuth(verify, { kind: 'system' }, async (ctx): Promise<HttpResult> => {
      // rawContentType, NOT ctx.contentType: the latter is lower-cased and a
      // multipart boundary is case-sensitive (see shared-http/multipart.ts).
      const form: MultipartForm = parseMultipartFormData(
        await ctx.rawBody(),
        rawContentType(ctx.headers),
        { maxParts: MAX_PARTS, maxFiles: 1, maxFieldBytes: MAX_FIELD_BYTES },
      );

      const file = form.files[0];
      if (file === undefined) {
        throw new HttpError(400, 'MISSING_FILE', `A file part named "${FILE_FIELD}" is required.`);
      }
      if (file.fieldName !== FILE_FIELD) {
        throw new HttpError(
          400,
          'MISSING_FILE',
          `The file part must be named "${FILE_FIELD}", got "${file.fieldName}".`,
        );
      }
      if (file.filename.length > MAX_FILENAME_LENGTH || CONTROL_CHAR_RE.test(file.filename)) {
        throw new HttpError(400, 'INVALID_FILENAME', 'The filename is too long or malformed.');
      }
      if (file.bytes.length === 0) {
        throw new HttpError(400, 'EMPTY_FILE', 'The uploaded file is empty.');
      }
      if (file.bytes.length > options.maxFileSizeBytes) {
        throw new HttpError(
          413,
          'FILE_TOO_LARGE',
          `The file exceeds the ${options.maxFileSizeBytes}-byte limit.`,
        );
      }
      if (!allowed.has(file.contentType)) {
        throw new HttpError(
          422,
          'UNSUPPORTED_FILE_TYPE',
          `Declared type "${file.contentType}" is not accepted.`,
        );
      }

      const applicantId = requireUuid(form, 'applicantId');
      const applicationId = requireUuid(form, 'applicationId');
      const rawDocumentType = form.fields.get('documentType');
      if (rawDocumentType === undefined || !KNOWN_DOCUMENT_TYPES.has(rawDocumentType)) {
        throw new HttpError(400, 'INVALID_DOCUMENT_TYPE', 'documentType is missing or unknown.');
      }
      const documentType = rawDocumentType as DocumentType;

      try {
        const outcome = await service.upload({
          applicantId,
          applicationId,
          documentType,
          declaredMediaType: file.contentType,
          bytes: file.bytes,
          context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
        });
        return mapOutcome(outcome, documentType);
      } catch (err) {
        throw mapDomainError(err);
      }
    }),
  };
}

function mapOutcome(outcome: UploadDocumentOutcome, documentType: DocumentType): HttpResult {
  switch (outcome.kind) {
    case 'UPLOADED':
      return {
        status: 201,
        body: { status: 'UPLOADED', documentId: outcome.documentId, documentType },
      };
    case 'APPLICATION_NOT_FOUND':
      return { status: 404, body: { error: 'APPLICATION_NOT_FOUND' } };
    case 'NOT_ACCEPTING_DOCUMENTS':
      return {
        status: 409,
        body: { error: 'NOT_ACCEPTING_DOCUMENTS', currentStatus: outcome.status },
      };
    case 'UNSUPPORTED_DOCUMENT_TYPE':
      return { status: 422, body: { error: 'UNSUPPORTED_DOCUMENT_TYPE' } };
    case 'UNSUPPORTED_CONTENT':
      return { status: 422, body: { error: 'UNSUPPORTED_FILE_CONTENT' } };
    case 'CONTENT_TYPE_MISMATCH':
      return {
        status: 422,
        body: { error: 'CONTENT_TYPE_MISMATCH', declared: outcome.declared },
      };
    case 'MALWARE_DETECTED':
      return { status: 422, body: { error: 'DOCUMENT_REJECTED_MALWARE' } };
    case 'SCANNER_UNAVAILABLE':
      return { status: 503, body: { error: 'SCANNER_UNAVAILABLE' } };
    default:
      return assertNever(outcome);
  }
}

function requireUuid(form: MultipartForm, field: string): string {
  const value = form.fields.get(field);
  if (value === undefined || !UUID_RE.test(value)) {
    throw new HttpError(400, 'INVALID_REQUEST', `Field "${field}" must be a UUID.`);
  }
  return value;
}

function mapDomainError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ObjectStoreUnavailableError) {
    return new HttpError(503, 'OBJECT_STORE_UNAVAILABLE', 'object store unreachable', {
      cause: err,
    });
  }
  if (err instanceof DocumentEnvelopeError) {
    return new HttpError(500, 'DOCUMENT_ENCRYPTION_ERROR', 'failed to seal the document', {
      cause: err,
    });
  }
  if (err instanceof ForensicsPersistenceError) {
    return new HttpError(500, 'FORENSICS_PERSISTENCE_ERROR', 'failed to record verdict', {
      cause: err,
    });
  }
  return new HttpError(500, 'INTERNAL_ERROR', 'unexpected failure', { cause: err });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled upload outcome: ${JSON.stringify(value)}`);
}
