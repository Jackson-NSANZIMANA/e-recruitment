// ══════════════════════════════════════════════════════════════════
// edge-gateway — Session domain types
//
// Domain entities for session management. These types represent the core
// business concepts of the edge gateway: authenticated sessions carrying
// credentials and authorization context for officers and applicants.
//
// Aligned with existing guards.ts expectations for backward compatibility.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';

/** The two kinds of authenticated sessions the edge supports. */
export type SessionKind = 'officer' | 'applicant';

/** Why a session is no longer usable. The UI says a different true thing for each. */
export type SessionEndedReason = 'idle' | 'absolute' | 'revoked';

/**
 * The full session record as persisted in edge_sessions and resolved by guards.
 * Every session holds a live upstream credential (JWT from iam-service or
 * applicant-auth opaque handle), which makes the edge the single highest-value
 * target in the platform: a compromised edge_sessions table is a credential warehouse.
 */
export interface EdgeSession {
  readonly sessionId: string;
  readonly kind: SessionKind;
  /** Officer UUID. Null for an applicant — the edge never learns who they are. */
  readonly subjectId: string | null;
  /** Officer agency. Null for an applicant: a citizen is cross-agency (ADR-014). */
  readonly agency: Agency | null;
  readonly roles: readonly string[];
  /** DECRYPTED, in-memory, request-scoped. Forwarded upstream; never returned. */
  readonly upstreamCredential: string;
  /** When the upstream credential itself dies (officer JWT `exp`). */
  readonly upstreamExpiresAt: string | null;
  readonly csrfTokenHash: string;
  readonly previousCsrfTokenHash: string | null;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

/**
 * The session as exposed to the browser (GET /edge/v1/session). The credential
 * never leaves the edge, so upstreamCredential is NEVER in this shape. The
 * session handle stays in the cookie, so sessionId is not here either.
 */
export interface OfficerSessionView {
  readonly kind: 'officer';
  readonly agency: Agency;
  readonly roles: readonly string[];
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

export interface ApplicantSessionView {
  readonly kind: 'applicant';
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

export type SessionView = OfficerSessionView | ApplicantSessionView;

/**
 * Transform a full EdgeSession into the browser-facing view. The credential
 * and session id are REDACTED — they never appear in a response body.
 */
export function toSessionView(session: EdgeSession): SessionView {
  if (session.kind === 'officer') {
    // A stored officer row without an agency is unrepresentable: the DB CHECK
    // constraint forbids it and create() will not accept it. Failing loudly
    // here beats emitting a session with a missing agency the UI would then
    // have to guess at.
    if (session.agency === null) {
      throw new Error('Officer session without an agency — refusing to build a session view.');
    }
    return {
      kind: 'officer',
      agency: session.agency,
      roles: session.roles,
      idleExpiresAt: session.idleExpiresAt.toISOString(),
      absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
    };
  }
  return {
    kind: 'applicant',
    idleExpiresAt: session.idleExpiresAt.toISOString(),
    absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
  };
}
