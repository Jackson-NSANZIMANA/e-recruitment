// ══════════════════════════════════════════════════════════════════
// @usrp/shared-types — The document door's closed vocabulary (D7)
//
// THE DEFECT THIS CLOSES. document-forensics-service and identity-service each
// kept their own hand-written list of the codes the upload door can answer.
// They disagreed, silently: forensics answered `INVALID_DOCUMENT_TYPE`, identity
// did not know the word, so it classified a caller error as
// DEPENDENCY_UNAVAILABLE, the edge turned that into `503 UPSTREAM_UNAVAILABLE`,
// and the citizen was told to try again later — forever — about something only
// they could fix. The same trap swallowed `SCANNER_UNAVAILABLE` (truthfully
// retryable), `OBJECT_STORE_UNAVAILABLE`, `DOCUMENT_ENCRYPTION_ERROR` and
// `FORENSICS_PERSISTENCE_ERROR`.
//
// THE RULE. A closed code, its HTTP status, and its citizen-facing meaning are
// declared HERE once, with the service that emits it. Producers render from this
// table; consumers classify from this table; nothing retypes a string literal.
// `verify-document-door-contract.ts` asserts the two services agree with it in
// both directions, so the next drift fails the gate instead of a citizen's
// upload.
//
// AND THE DIRECTION THAT MATTERS. An upstream 4xx we cannot classify is NEVER
// "unavailable". Tell a citizen to retry a refusal and they retry forever; tell
// them nothing and they call a helpline. It becomes `DOCUMENT_REFUSED` plus an
// ERROR log — loud drift, honest UX.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from './agency.types.js';
import { AGENCY_DOCUMENT_TYPES } from './eligibility.types.js';
import type { DocumentType } from './eligibility.types.js';

/**
 * Who must act, which is what the citizen-facing copy turns on.
 *   CALLER        — the request is wrong; changing the request fixes it.
 *   UPLOADER      — this file cannot be accepted; a different file may be.
 *   SYSTEM        — a dependency is down; retrying later is genuinely the answer.
 *   ELIGIBILITY   — the application is past the point where documents are taken.
 */
export type DocumentDoorActor = 'CALLER' | 'UPLOADER' | 'SYSTEM' | 'ELIGIBILITY';

export type DocumentDoorCode =
  // ── The door took the document ──────────────────────────────────
  | 'UPLOADED'
  // ── CALLER: the request itself is malformed or out of place ─────
  | 'INVALID_REQUEST'
  | 'INVALID_FILENAME'
  | 'MISSING_FILE'
  | 'EMPTY_FILE'
  | 'FORBIDDEN_FIELD'
  | 'INVALID_DOCUMENT_TYPE'
  | 'UNSUPPORTED_DOCUMENT_TYPE'
  | 'APPLICATION_NOT_FOUND'
  | 'NOT_ACCEPTING_DOCUMENTS'
  // ── UPLOADER: these bytes cannot be accepted ────────────────────
  | 'UNSUPPORTED_FILE_TYPE'
  | 'UNSUPPORTED_FILE_CONTENT'
  | 'CONTENT_TYPE_MISMATCH'
  | 'DOCUMENT_REJECTED_MALWARE'
  | 'FILE_TOO_LARGE'
  | 'DOCUMENT_REFUSED'
  // ── SYSTEM: a dependency failed, retrying later is the answer ───
  | 'SCANNER_UNAVAILABLE'
  | 'OBJECT_STORE_UNAVAILABLE'
  | 'DOCUMENT_ENCRYPTION_ERROR'
  | 'FORENSICS_PERSISTENCE_ERROR'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'DOCUMENTS_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  // ── ELIGIBILITY: the case has moved past document intake ────────
  | 'DOCUMENT_REVIEW_CLOSED';

export interface DocumentDoorCodeSpec {
  /** The HTTP status the OWNING service answers with. */
  readonly status: number;
  readonly actor: DocumentDoorActor;
}

/**
 * The one table. Adding a code means adding it here, which makes it known to
 * both services at compile time and to the parity proof at run time.
 */
export const DOCUMENT_DOOR_CODES: Readonly<Record<DocumentDoorCode, DocumentDoorCodeSpec>> = {
  UPLOADED: { status: 201, actor: 'CALLER' },
  INVALID_REQUEST: { status: 400, actor: 'CALLER' },
  INVALID_FILENAME: { status: 400, actor: 'CALLER' },
  MISSING_FILE: { status: 400, actor: 'CALLER' },
  EMPTY_FILE: { status: 400, actor: 'CALLER' },
  FORBIDDEN_FIELD: { status: 400, actor: 'CALLER' },
  INVALID_DOCUMENT_TYPE: { status: 400, actor: 'CALLER' },
  UNSUPPORTED_DOCUMENT_TYPE: { status: 422, actor: 'CALLER' },
  APPLICATION_NOT_FOUND: { status: 404, actor: 'CALLER' },
  NOT_ACCEPTING_DOCUMENTS: { status: 409, actor: 'ELIGIBILITY' },
  UNSUPPORTED_FILE_TYPE: { status: 422, actor: 'UPLOADER' },
  UNSUPPORTED_FILE_CONTENT: { status: 422, actor: 'UPLOADER' },
  CONTENT_TYPE_MISMATCH: { status: 422, actor: 'UPLOADER' },
  DOCUMENT_REJECTED_MALWARE: { status: 422, actor: 'UPLOADER' },
  FILE_TOO_LARGE: { status: 413, actor: 'UPLOADER' },
  DOCUMENT_REFUSED: { status: 422, actor: 'UPLOADER' },
  SCANNER_UNAVAILABLE: { status: 503, actor: 'SYSTEM' },
  OBJECT_STORE_UNAVAILABLE: { status: 503, actor: 'SYSTEM' },
  DOCUMENT_ENCRYPTION_ERROR: { status: 500, actor: 'SYSTEM' },
  FORENSICS_PERSISTENCE_ERROR: { status: 500, actor: 'SYSTEM' },
  DEPENDENCY_UNAVAILABLE: { status: 502, actor: 'SYSTEM' },
  DOCUMENTS_UNAVAILABLE: { status: 503, actor: 'SYSTEM' },
  INTERNAL_ERROR: { status: 500, actor: 'SYSTEM' },
  DOCUMENT_REVIEW_CLOSED: { status: 409, actor: 'ELIGIBILITY' },
};

/**
 * The codes identity-service may RELAY to a citizen, with the status it relays
 * them as. `INVALID_DOCUMENT_TYPE` deliberately becomes 422
 * `UNSUPPORTED_DOCUMENT_TYPE`: a well-formed request naming a document type this
 * agency does not accept is a semantic refusal, not a malformed one — and it is
 * the citizen's to fix either way.
 *
 * Anything not in this table is NOT relayed: it is logged and answered as
 * `DOCUMENT_REFUSED` (a 4xx we could not classify) or `DEPENDENCY_UNAVAILABLE`
 * (a 5xx), never as a silent "try again".
 */
export const DOCUMENT_DOOR_RELAY: Readonly<Partial<Record<DocumentDoorCode, { readonly as: DocumentDoorCode }>>> = {
  APPLICATION_NOT_FOUND: { as: 'APPLICATION_NOT_FOUND' },
  NOT_ACCEPTING_DOCUMENTS: { as: 'NOT_ACCEPTING_DOCUMENTS' },
  DOCUMENT_REVIEW_CLOSED: { as: 'DOCUMENT_REVIEW_CLOSED' },
  INVALID_DOCUMENT_TYPE: { as: 'UNSUPPORTED_DOCUMENT_TYPE' },
  UNSUPPORTED_DOCUMENT_TYPE: { as: 'UNSUPPORTED_DOCUMENT_TYPE' },
  UNSUPPORTED_FILE_TYPE: { as: 'UNSUPPORTED_FILE_TYPE' },
  UNSUPPORTED_FILE_CONTENT: { as: 'UNSUPPORTED_FILE_CONTENT' },
  CONTENT_TYPE_MISMATCH: { as: 'CONTENT_TYPE_MISMATCH' },
  DOCUMENT_REJECTED_MALWARE: { as: 'DOCUMENT_REJECTED_MALWARE' },
  FILE_TOO_LARGE: { as: 'FILE_TOO_LARGE' },
  SCANNER_UNAVAILABLE: { as: 'SCANNER_UNAVAILABLE' },
  DOCUMENT_REFUSED: { as: 'DOCUMENT_REFUSED' },
};

/** Is this string a code in the closed vocabulary? */
export function isDocumentDoorCode(value: string): value is DocumentDoorCode {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_DOOR_CODES, value);
}

/** The status the OWNING service answers with, or undefined for an unknown code. */
export function statusForDocumentDoorCode(value: string): number | undefined {
  return isDocumentDoorCode(value) ? DOCUMENT_DOOR_CODES[value].status : undefined;
}

/** Who must act for this code, or undefined for an unknown code. */
export function actorForDocumentDoorCode(value: string): DocumentDoorActor | undefined {
  return isDocumentDoorCode(value) ? DOCUMENT_DOOR_CODES[value].actor : undefined;
}

/**
 * The relay decision, in one pure function so the rule can be argued about in a
 * test instead of discovered in production.
 *
 * @param upstreamStatus the status document-forensics-service answered with
 * @param upstreamCode   the code from its body, if it named one
 */
export function classifyDocumentDoorAnswer(
  upstreamStatus: number,
  upstreamCode: string | undefined,
): { readonly kind: 'UPLOADED' } | { readonly kind: 'RELAY'; readonly code: DocumentDoorCode; readonly status: number } | { readonly kind: 'DEPENDENCY_UNAVAILABLE' } {
  if (upstreamStatus === 201) return { kind: 'UPLOADED' };
  if (upstreamCode !== undefined) {
    const relayed = DOCUMENT_DOOR_RELAY[upstreamCode as DocumentDoorCode];
    if (relayed !== undefined) {
      return { kind: 'RELAY', code: relayed.as, status: DOCUMENT_DOOR_CODES[relayed.as].status };
    }
  }
  // A 4xx we do not recognise is a REFUSAL with an unknown reason: relaying it
  // as "unavailable" would teach the citizen to retry a closed door, and
  // swallowing it entirely would hide the drift. Answer honestly, log loudly.
  if (upstreamStatus >= 400 && upstreamStatus < 500) {
    return { kind: 'RELAY', code: 'DOCUMENT_REFUSED', status: DOCUMENT_DOOR_CODES.DOCUMENT_REFUSED.status };
  }
  return { kind: 'DEPENDENCY_UNAVAILABLE' };
}

/** Every document type any agency models — derived, never retyped. */
export const KNOWN_DOCUMENT_TYPES: ReadonlySet<DocumentType> = new Set<DocumentType>(
  Object.values(AGENCY_DOCUMENT_TYPES).flatMap((types) => [...types]),
);

/** Is this string a document type USRP models at all? (the "is that a word" gate) */
export function isKnownDocumentType(value: string): value is DocumentType {
  return KNOWN_DOCUMENT_TYPES.has(value as DocumentType);
}

/** Does this agency model this document type? The per-agency gate, shared. */
export function isDocumentTypeSupported(agency: Agency, documentType: string): boolean {
  return (AGENCY_DOCUMENT_TYPES[agency] as ReadonlySet<string>).has(documentType);
}
