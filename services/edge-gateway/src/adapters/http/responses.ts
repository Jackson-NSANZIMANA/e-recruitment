// ══════════════════════════════════════════════════════════════════
// edge-gateway — The response vocabulary
//
// Every error body the edge can emit lives here, so "what does this leak" is
// answerable by reading one file.
//
// `bareError()` returns `{}` — an INTENTIONALLY EMPTY body. It is used exactly
// where any detail would leak: the 404s (id enumeration across agencies) and
// the credential rejections (account enumeration). Do not add a `message`
// "for debuggability": the correlation id, echoed on every response by
// shared-http, is how these are debugged.
// ══════════════════════════════════════════════════════════════════

import type { HttpResult } from '@usrp/shared-http';
import type { SessionEndedReason } from '../../domain/session.js';

/** `{}` — see the file header. Never enrich this. */
export function bareError(status: number): HttpResult {
  return { status, body: {} };
}

/** A stable machine code the UI maps to localised copy. */
export function codedError(status: number, error: string, message?: string): HttpResult {
  return {
    status,
    body: message === undefined ? { error } : { error, message },
  };
}

/**
 * 401 with the reason the UI needs. Omitted when there never was a session —
 * "you were away too long" is wrong for a first-time visitor.
 */
export function sessionEnded(reason?: SessionEndedReason): HttpResult {
  return { status: 401, body: reason === undefined ? {} : { reason } };
}

/**
 * Authenticated with the WRONG session kind. Reaching this means the client
 * skipped its own `requireOfficerSession` boundary, so it is worth logging as a
 * client bug rather than treating as routine.
 */
export function wrongSessionKind(): HttpResult {
  return codedError(403, 'WRONG_SESSION_KIND', 'This operation requires a different session kind.');
}

export function csrfRejected(): HttpResult {
  return codedError(403, 'CSRF_REJECTED', 'Missing or mismatched x-csrf-token header.');
}

export function rateLimited(): HttpResult {
  return codedError(429, 'RATE_LIMITED', 'Too many requests; retry shortly.');
}

/** A named G2G dependency is down. The name is safe AND worth distinguishing. */
export function upstreamUnavailable(authority: string): HttpResult {
  return { status: 503, body: { error: authority } };
}

/** "Your request was accepted." Nothing about its subject. */
export function bareAccepted(): HttpResult {
  return { status: 202, body: { accepted: true } };
}
