// ══════════════════════════════════════════════════════════════════
// document-forensics-service — Analyze ingress (HTTP adapter)
//
// POST /v1/forensics/analyze — SYSTEM-token only (withAuth kind:'system'):
// until the upload/portal slice exists, document ingestion is modeled as a
// service-internal reference handoff, exactly like the other front doors.
// Body carries the reference: applicationId + agency + documentType +
// objectKey (+ optional bucket). Outcome → status mapping mirrors the
// established controllers; infra faults map to 500/503, never a stack leak.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import type { Agency, DocumentType } from '@usrp/shared-types';
import { ObjectStoreUnavailableError } from '../../ports/object-store.js';
import { ForensicsPersistenceError } from '../../domain/forensics.errors.js';
import type {
  AnalyzeDocumentOutcome,
  AnalyzeDocumentService,
} from '../../application/analyze-document.service.js';

export const ANALYZE_DOCUMENT_PATH = '/v1/forensics/analyze';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENCIES: ReadonlySet<string> = new Set(['RDF', 'RNP', 'RCS']);
const DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  'NATIONAL_ID',
  'APPLICATION_FORM_WITH_PHOTO',
  'ALEVEL_CERTIFICATE',
  'OLEVEL_CERTIFICATE',
  'DEGREE_DIPLOMA_COPY',
  'DEGREE_DIPLOMA_NOTARIZED',
  'GOOD_CONDUCT_CERTIFICATE',
  'NON_CONVICTION_CERTIFICATE',
  'CELIBACY_CERTIFICATE',
  'MEDICAL_CERTIFICATE_GOVT',
  'BIRTH_CERTIFICATE',
]);
const MAX_KEY_LENGTH = 512;   // matches minio_object_key varchar(512)
const MAX_BUCKET_LENGTH = 100; // matches minio_object_bucket varchar(100)
const DEFAULT_BUCKET = 'usrp-documents';

interface AnalyzeBody {
  readonly applicationId?: unknown;
  readonly agency?: unknown;
  readonly documentType?: unknown;
  readonly objectKey?: unknown;
  readonly objectBucket?: unknown;
}

export function analyzeDocumentRoute(service: AnalyzeDocumentService, verify: AuthVerifier): Route {
  return {
    method: 'POST',
    path: ANALYZE_DOCUMENT_PATH,
    handler: withAuth(verify, { kind: 'system' }, async (ctx): Promise<HttpResult> => {
      const body = await ctx.json<AnalyzeBody>();

      const applicationId = requireString(body.applicationId, 'applicationId', MAX_KEY_LENGTH);
      if (!UUID_RE.test(applicationId)) {
        throw new HttpError(400, 'INVALID_APPLICATION_ID', 'applicationId must be a UUID');
      }
      const agency = requireString(body.agency, 'agency', 8);
      if (!AGENCIES.has(agency)) {
        throw new HttpError(400, 'INVALID_AGENCY', 'agency must be RDF | RNP | RCS');
      }
      const documentType = requireString(body.documentType, 'documentType', 64);
      if (!DOCUMENT_TYPES.has(documentType)) {
        throw new HttpError(400, 'INVALID_DOCUMENT_TYPE', 'unknown documentType');
      }
      const objectKey = requireString(body.objectKey, 'objectKey', MAX_KEY_LENGTH);
      const objectBucket =
        body.objectBucket === undefined
          ? DEFAULT_BUCKET
          : requireString(body.objectBucket, 'objectBucket', MAX_BUCKET_LENGTH);

      try {
        const outcome = await service.analyze({
          applicationId,
          agency: agency as Agency,
          documentType: documentType as DocumentType,
          objectBucket,
          objectKey,
          context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
        });
        return mapOutcome(outcome);
      } catch (err) {
        throw mapDomainError(err);
      }
    }),
  };
}

function mapOutcome(outcome: AnalyzeDocumentOutcome): HttpResult {
  switch (outcome.kind) {
    case 'ANALYZED':
      return {
        status: 200,
        body: {
          status: 'ANALYZED',
          documentId: outcome.documentId,
          lane: outcome.verdict.lane,
          forensicsScore: outcome.verdict.score,
          flags: outcome.verdict.flags,
        },
      };
    case 'APPLICATION_NOT_FOUND':
      return { status: 404, body: { error: 'APPLICATION_NOT_FOUND' } };
    case 'OBJECT_NOT_FOUND':
      return { status: 404, body: { error: 'OBJECT_NOT_FOUND' } };
    case 'UNSUPPORTED_DOCUMENT_TYPE':
      return { status: 422, body: { error: 'UNSUPPORTED_DOCUMENT_TYPE' } };
    case 'SCANNER_UNAVAILABLE':
      return { status: 503, body: { error: 'SCANNER_UNAVAILABLE' } };
  }
}

function mapDomainError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ObjectStoreUnavailableError) {
    return new HttpError(503, 'OBJECT_STORE_UNAVAILABLE', 'object store unreachable', { cause: err });
  }
  if (err instanceof ForensicsPersistenceError) {
    return new HttpError(500, 'FORENSICS_PERSISTENCE_ERROR', 'failed to record verdict', { cause: err });
  }
  return new HttpError(500, 'INTERNAL_ERROR', 'unexpected failure', { cause: err });
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'MISSING_FIELD', `${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new HttpError(400, 'FIELD_TOO_LONG', `${field} exceeds ${maxLength} chars`);
  }
  return trimmed;
}
