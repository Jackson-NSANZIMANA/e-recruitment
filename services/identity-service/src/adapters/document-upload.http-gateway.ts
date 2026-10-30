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
import { logError, summariseError } from '@usrp/shared-logging';
import type {
  DocumentRefusal,
  DocumentUploadGateway,
  DocumentUploadInput,
  DocumentUploadResult,
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

const REFUSALS: ReadonlySet<string> = new Set<DocumentRefusal>([
  'APPLICATION_NOT_FOUND',
  'NOT_ACCEPTING_DOCUMENTS',
  'UNSUPPORTED_DOCUMENT_TYPE',
  'UNSUPPORTED_FILE_CONTENT',
  'CONTENT_TYPE_MISMATCH',
  'DOCUMENT_REJECTED_MALWARE',
  'FILE_TOO_LARGE',
  'UNSUPPORTED_FILE_TYPE',
]);

/**
 * The document door's vocabulary folded onto ours (evaluation D7).
 *
 * `INVALID_DOCUMENT_TYPE` is the door's "that string is not a document type of
 * ANY agency" — the same citizen-facing fact as `UNSUPPORTED_DOCUMENT_TYPE`
 * ("a type, just not one this agency models"), which is already in this
 * contract and in the edge's refusal allowlist. Left untranslated it fell
 * through as a dependency fault: 502 DEPENDENCY_UNAVAILABLE here, then
 * 503 UPSTREAM_UNAVAILABLE at the edge — a 4xx the citizen can fix, reported to
 * them as our outage, and unrecoverable from the UI.
 *
 * It is the ONE reachable alias. Every other 4xx the door can answer with
 * (MISSING_FILE, EMPTY_FILE, INVALID_FILENAME, INVALID_REQUEST) is already
 * refused by our own handler before the forward, so translating them here would
 * be dead code pretending to be a defence.
 */
const FORENSICS_REFUSAL_ALIASES: Readonly<Record<string, DocumentRefusal>> = {
  INVALID_DOCUMENT_TYPE: 'UNSUPPORTED_DOCUMENT_TYPE',
};

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

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 201) {
      const documentId = body['documentId'];
      if (typeof documentId !== 'string') return { kind: 'DEPENDENCY_UNAVAILABLE' };
      // The response is rebuilt from two known fields; nothing else is relayed.
      return { kind: 'UPLOADED', documentId, documentType: input.documentType };
    }
    const rawCode = typeof body['error'] === 'string' ? body['error'] : '';
    const code = FORENSICS_REFUSAL_ALIASES[rawCode] ?? rawCode;
    if (res.status >= 400 && res.status < 500 && REFUSALS.has(code)) {
      return { kind: 'REFUSED', httpStatus: res.status, code: code as DocumentRefusal };
    }
    // Status and closed code only — never the body, which is not ours to log.
    logError('document_door_dependency_unavailable', { stage: 'forensics_response', status: res.status, code });
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
