// ══════════════════════════════════════════════════════════════════
// identity-service — DocumentUploadGateway adapter (HTTP)
//
// Re-builds the multipart body FROM SCRATCH: the subject comes from the
// session, the file is passed through byte-for-byte, and no client-supplied
// part other than applicationId/documentType/file survives. Authenticates to
// document-forensics-service with this service's iam client-credentials
// token (the same identity the submit bridge uses).
// ══════════════════════════════════════════════════════════════════

import { buildMultipartFormData } from '@usrp/shared-http';
import { classifyDocumentDoorAnswer } from '@usrp/shared-types';
import { logError, summariseError } from '@usrp/shared-logging';
import {
  isDocumentReviewClosedReason,
  type DocumentRefusal,
  type DocumentUploadGateway,
  type DocumentUploadInput,
  type DocumentUploadResult,
} from '../ports/document-upload-gateway.js';

export interface DocumentUploadGatewayOptions {
  readonly iamBaseUrl: string;
  readonly forensicsBaseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000; // virus scan + sealing legitimately takes seconds
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DOCUMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDocumentId(value: unknown): value is string {
  return typeof value === 'string' && DOCUMENT_ID_RE.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

export class HttpDocumentUploadGateway implements DocumentUploadGateway {
  readonly #opts: DocumentUploadGatewayOptions;
  readonly #fetch: typeof fetch;
  #cached: { token: string; expiresAtMs: number } | null = null;

  constructor(options: DocumentUploadGatewayOptions) {
    this.#opts = options;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async uploadForApplicant(
    applicantId: string,
    input: DocumentUploadInput,
  ): Promise<DocumentUploadResult> {
    let token: string;
    try {
      token = await this.#systemToken();
    } catch (err) {
      // The citizen sees one opaque 502; the operator must see WHICH hop failed.
      logError('document_door_dependency_unavailable', { stage: 'iam_token', error: summariseError(err) });
      return { kind: 'DEPENDENCY_UNAVAILABLE' };
    }
    const multipart = buildMultipartFormData(
      { applicantId, applicationId: input.applicationId, documentType: input.documentType },
      { fieldName: 'file', contentType: input.file.contentType, bytes: input.file.bytes },
    );

    let res: Response;
    try {
      res = await this.#fetch(`${this.#opts.forensicsBaseUrl}/v1/documents/upload`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': multipart.contentType },
        body: multipart.body,
        signal: AbortSignal.timeout(this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      logError('document_door_dependency_unavailable', { stage: 'forensics_transport', error: summariseError(err) });
      return { kind: 'DEPENDENCY_UNAVAILABLE' };
    }
    if (res.status === 401) this.#cached = null;

    const rawBody: unknown = await res.json().catch(() => null);
    const body = isRecord(rawBody) ? rawBody : {};
    const code = typeof body['error'] === 'string' ? body['error'] : undefined;
    // ONE classification, from the one shared table (D7). A 4xx we cannot name is
    // a REFUSAL, not an outage: an unclassified refusal must never be relayed as
    // "the service is unavailable", because that teaches the citizen to retry a
    // closed door forever. The drift is logged, loudly, rather than swallowed.
    const answer = classifyDocumentDoorAnswer(res.status, code);
    if (answer.kind === 'UPLOADED') {
      const invalidFields: string[] = [];
      if (body['status'] !== 'UPLOADED') invalidFields.push('status');
      if (!isDocumentId(body['documentId'])) invalidFields.push('documentId');
      if (body['documentType'] !== input.documentType) invalidFields.push('documentType');
      if (!isPositiveSafeInteger(body['revision'])) invalidFields.push('revision');
      if (invalidFields.length > 0) {
        logError('document_door_contract_drift', {
          stage: 'forensics_response',
          status: res.status,
          code: 'INVALID_UPLOAD_SUCCESS',
          fields: invalidFields,
        });
        return { kind: 'DEPENDENCY_UNAVAILABLE' };
      }
      // The response is rebuilt from the four approved fields; nothing else is relayed.
      return {
        kind: 'UPLOADED',
        documentId: body['documentId'] as string,
        documentType: input.documentType,
        revision: body['revision'] as number,
      };
    }
    if (answer.kind === 'RELAY') {
      if (answer.code === 'DOCUMENT_REVIEW_CLOSED') {
        const reason = body['reason'];
        if (res.status !== 409 || !isDocumentReviewClosedReason(reason)) {
          // Log only the drift category, never arbitrary upstream reason text.
          logError('document_door_contract_drift', {
            stage: 'forensics_response',
            status: res.status,
            code: 'DOCUMENT_REVIEW_CLOSED',
            reason: reason === undefined ? 'MISSING' : 'UNRECOGNIZED',
          });
          return { kind: 'DEPENDENCY_UNAVAILABLE' };
        }
        return { kind: 'REFUSED', httpStatus: 409, code: 'DOCUMENT_REVIEW_CLOSED', reason };
      }
      if (answer.code === 'DOCUMENT_REFUSED') {
        // Status and closed code only — the body is not ours to log.
        logError('document_door_contract_drift', { stage: 'forensics_response', status: res.status, code: code ?? 'UNNAMED' });
      }
      return {
        kind: 'REFUSED',
        httpStatus: answer.status,
        code: answer.code as Exclude<DocumentRefusal, 'DOCUMENT_REVIEW_CLOSED'>,
      };
    }
    // Status and closed code only — never the body, which is not ours to log.
    logError('document_door_dependency_unavailable', { stage: 'forensics_response', status: res.status, code: code ?? 'UNNAMED' });
    return { kind: 'DEPENDENCY_UNAVAILABLE' };
  }

  async #systemToken(): Promise<string> {
    const now = Date.now();
    if (this.#cached && this.#cached.expiresAtMs - now > TOKEN_REFRESH_MARGIN_MS) {
      return this.#cached.token;
    }
    const res = await this.#fetch(`${this.#opts.iamBaseUrl}/v1/auth/service/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: this.#opts.clientId, clientSecret: this.#opts.clientSecret }),
      signal: AbortSignal.timeout(this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (res.status !== 200) throw new Error(`iam responded ${String(res.status)}`);
    const body = (await res.json()) as { token?: string; expiresAt?: string };
    if (typeof body.token !== 'string' || typeof body.expiresAt !== 'string') {
      throw new Error('iam token response malformed');
    }
    this.#cached = { token: body.token, expiresAtMs: Date.parse(body.expiresAt) };
    return body.token;
  }
}
