// ══════════════════════════════════════════════════════════════════
// application-service — Document checklist + venue verification routes (ADR-032)
//
//   GET  /v1/applications/document-checklist?applicationId=        officer  application.read
//   GET  /v1/applications/document-checklist/by-applicant
//          ?applicantId=&applicationId=                            system   (identity bridge)
//   POST /v1/applications/documents/verify-at-venue                 officer  document.verify.venue
//
// ADVISORY: none of these moves an application. The body carries document
// types, satisfaction states and the verifying registry — never a forensic
// score, flag, object key or an officer identity.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { requireOfficerPermission, withAuth, type AuthVerifier } from '@usrp/shared-auth';
import type { DocumentType } from '@usrp/shared-types';
import { ApplicationPersistenceError, ApplicationReadError } from '../../domain/application.errors.js';
import { REGISTRY_FOR_DOCUMENT, type DocumentChecklist } from '../../domain/document-requirements.js';
import type { DocumentChecklistService } from '../../application/document-checklist.service.js';

export const DOCUMENT_CHECKLIST_PATH = '/v1/applications/document-checklist';
export const DOCUMENT_CHECKLIST_BY_APPLICANT_PATH = '/v1/applications/document-checklist/by-applicant';
export const VERIFY_DOCUMENT_AT_VENUE_PATH = '/v1/applications/documents/verify-at-venue';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOCUMENT_TYPES: ReadonlySet<string> = new Set(Object.keys(REGISTRY_FOR_DOCUMENT));

function uuidParam(value: string | null | undefined, field: string): string {
  const v = value?.trim() ?? '';
  if (!UUID_RE.test(v)) throw new HttpError(400, 'INVALID_REQUEST', `"${field}" must be a UUID.`);
  return v;
}

function body(agency: string, checklist: DocumentChecklist): Record<string, unknown> {
  return {
    agency,
    source: checklist.source,
    complete: checklist.complete,
    items: checklist.items.map((i) => ({
      documentType: i.documentType,
      satisfaction: i.satisfaction,
      registry: i.registry,
      ...(i.clearance === undefined ? {} : { clearance: { state: i.clearance.state, code: i.clearance.code, reasons: i.clearance.reasons } }),
    })),
  };
}

function mapError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ApplicationReadError || err instanceof ApplicationPersistenceError) {
    return new HttpError(500, 'APPLICATION_READ_ERROR', 'Could not read the document checklist.', { cause: err });
  }
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
}

export function documentChecklistRoutes(service: DocumentChecklistService, verify: AuthVerifier): Route[] {
  return [
    {
      method: 'GET',
      path: DOCUMENT_CHECKLIST_PATH,
      handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
        requireOfficerPermission(principal, 'application.read');
        const applicationId = uuidParam(ctx.query.get('applicationId'), 'applicationId');
        try {
          const outcome = await service.forOfficer(principal, applicationId);
          return outcome.kind === 'OK'
            ? { status: 200, body: body(outcome.agency, outcome.checklist) }
            : { status: 404, body: { error: 'NOT_FOUND' } };
        } catch (err) {
          throw mapError(err);
        }
      }),
    },
    {
      method: 'GET',
      path: DOCUMENT_CHECKLIST_BY_APPLICANT_PATH,
      handler: withAuth(verify, { kind: 'system' }, async (ctx): Promise<HttpResult> => {
        const applicantId = uuidParam(ctx.query.get('applicantId'), 'applicantId');
        const applicationId = uuidParam(ctx.query.get('applicationId'), 'applicationId');
        try {
          const outcome = await service.forApplicant(applicantId, applicationId);
          // Not theirs and nonexistent are the same answer.
          return outcome.kind === 'OK'
            ? { status: 200, body: body(outcome.agency, outcome.checklist) }
            : { status: 404, body: { error: 'NOT_FOUND' } };
        } catch (err) {
          throw mapError(err);
        }
      }),
    },
    {
      method: 'POST',
      path: VERIFY_DOCUMENT_AT_VENUE_PATH,
      handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
        requireOfficerPermission(principal, 'document.verify.venue');
        const raw = await ctx.json<{ applicationId?: unknown; documentType?: unknown }>();
        const applicationId = uuidParam(typeof raw.applicationId === 'string' ? raw.applicationId : '', 'applicationId');
        if (typeof raw.documentType !== 'string' || !DOCUMENT_TYPES.has(raw.documentType)) {
          throw new HttpError(400, 'INVALID_DOCUMENT_TYPE', '"documentType" is not a known document type.');
        }
        try {
          const outcome = await service.verifyAtVenue(
            principal,
            applicationId,
            raw.documentType as DocumentType,
            { correlationId: ctx.correlationId, causationId: ctx.correlationId },
          );
          switch (outcome.kind) {
            case 'RECORDED':
            case 'ALREADY_RECORDED':
              return {
                status: 200,
                body: { status: outcome.kind, checklist: body(principal.kind === 'officer' ? principal.agency : '', outcome.checklist) },
              };
            case 'NOT_FOUND':
              return { status: 404, body: { error: 'NOT_FOUND' } };
            case 'NOT_REQUIRED':
              return { status: 422, body: { error: 'NOT_REQUIRED' } };
            case 'UNSUPPORTED_DOCUMENT_TYPE':
              return { status: 422, body: { error: 'UNSUPPORTED_DOCUMENT_TYPE' } };
            case 'NOT_APPLICABLE':
              return { status: 409, body: { error: 'NOT_APPLICABLE', currentStatus: outcome.currentStatus } };
          }
        } catch (err) {
          throw mapError(err);
        }
      }),
    },
  ];
}
