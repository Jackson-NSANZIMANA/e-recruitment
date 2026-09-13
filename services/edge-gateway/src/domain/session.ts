// ══════════════════════════════════════════════════════════════════
// edge-gateway — The session domain
//
// TWO SHAPES, AND THE DIFFERENCE BETWEEN THEM IS THE WHOLE SECURITY MODEL:
//
//   EdgeSession  — server-side. Holds the real upstream credential.
//   SessionView  — what `GET /edge/v1/session` returns. Has NO credential
//                  field, so no component downstream can read, log or
//                  forward one. The absence is enforced by the type, not by
//                  remembering to strip a property.
//
// The browser never sees either: it holds an opaque HANDLE in an httpOnly
// cookie, and this module maps handle → EdgeSession → SessionView.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';

export type SessionKind = 'officer' | 'applicant';

/**
 * Why a session is gone. The UI says the right thing with it: `idle` earns
 * "you were away too long", `absolute` earns "sessions end after N hours",
 * `revoked` earns "this session was ended". Telling a user the wrong one
 * makes a working product look broken.
 */
export type SessionEndedReason = 'idle' | 'absolute' | 'revoked';

/** The server-side record. `credential` NEVER leaves this process. */
export type EdgeSession =
  | {
      readonly kind: 'officer';
      /** Ed25519 bearer JWT (ADR-016). Non-revocable upstream — which is why
       *  destroying the handle is the only officer revocation that exists. */
      readonly credential: string;
      readonly agency: Agency;
      readonly roles: readonly string[];
      readonly subjectId: string;
      readonly credentialExpiresAt: Date;
      readonly idleExpiresAt: Date;
      readonly absoluteExpiresAt: Date;
      readonly csrfToken: string;
    }
  | {
      readonly kind: 'applicant';
      /** Opaque 32-byte DB session token (ADR-018). Revocable upstream. */
      readonly credential: string;
      readonly credentialExpiresAt: Date;
      readonly idleExpiresAt: Date;
      readonly absoluteExpiresAt: Date;
      readonly csrfToken: string;
    };

/**
 * The wire shape of a session. A discriminated union so passing an applicant
 * session where an officer credential is required is a build failure rather
 * than a runtime surprise (matches `Session` in the frontend's `@usrp/auth`).
 */
export type SessionView =
  | {
      readonly kind: 'officer';
      readonly agency: Agency;
      readonly roles: readonly string[];
      readonly idleExpiresAt: string;
      readonly absoluteExpiresAt: string;
    }
  | {
      readonly kind: 'applicant';
      /** No agency, deliberately: a citizen is cross-agency by construction. */
      readonly idleExpiresAt: string;
      readonly absoluteExpiresAt: string;
    };

/**
 * `SUPERADMIN` is not a role this platform can express. RLS is FORCE'd with
 * NOLOGIN group roles and there is no bypass principal, so a token claiming
 * it would grant nothing — but rendering it would tell an operator the
 * opposite. Dropped on projection so it can never reach a UI.
 */
const UNREPRESENTABLE_ROLE = 'superadmin';

export function projectSession(session: EdgeSession): SessionView {
  if (session.kind === 'officer') {
    return {
      kind: 'officer',
      agency: session.agency,
      roles: session.roles.filter((role) => role.toLowerCase() !== UNREPRESENTABLE_ROLE),
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
