// ══════════════════════════════════════════════════════════════════
// edge-gateway — Session types
//
// Two shapes, and the difference between them is the security model:
//
//   EdgeSession  the SERVER's view. Carries the upstream credential. Never
//                serialized to a response — there is no code path that does,
//                because the response type is the other one.
//   SessionView  the BROWSER's view. Has no `token` field, so no component can
//                read, log, or forward one. It is not "a session with the token
//                removed"; it is a type with nowhere to put it.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';

export type EdgeSessionKind = 'officer' | 'applicant';

/** Why a session is no longer usable. The UI says a different true thing for each. */
export type SessionEndedReason = 'idle' | 'absolute' | 'revoked';

export interface EdgeSession {
  readonly sessionId: string;
  readonly kind: EdgeSessionKind;
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

/** A newly minted or rotated session: the two secrets the browser is handed. */
export interface IssuedSession {
  readonly handle: string;
  readonly csrfToken: string;
  readonly session: EdgeSession;
}

export type SessionLookup =
  | { readonly kind: 'ACTIVE'; readonly session: EdgeSession }
  | { readonly kind: 'ENDED'; readonly reason: SessionEndedReason }
  /** No such handle. Reported to the caller identically to ENDED/revoked. */
  | { readonly kind: 'UNKNOWN' };

export interface CreateSessionInput {
  readonly kind: EdgeSessionKind;
  readonly subjectId: string | null;
  readonly agency: Agency | null;
  readonly roles: readonly string[];
  readonly upstreamCredential: string;
  readonly upstreamExpiresAt: string | null;
}

/** Aggregate counts for the observability line. No per-session detail. */
export interface SessionStoreStats {
  readonly activeOfficer: number;
  readonly activeApplicant: number;
  readonly revoked: number;
  readonly expired: number;
}

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
