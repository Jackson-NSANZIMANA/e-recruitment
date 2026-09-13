// ══════════════════════════════════════════════════════════════════
// edge-gateway — EdgeSessionService
//
// Turns an upstream credential into an edge session, and an edge handle back
// into a session view. The only place a credential and a handle are in the same
// scope.
//
// THE ABSOLUTE CEILING IS min(configured, credential expiry), and that is not a
// detail. The edge cannot outlive the credential it is holding: an officer's
// Ed25519 JWT lives one hour (OFFICER_TOKEN_TTL_SECONDS) and a citizen's opaque
// token thirty minutes, and NEITHER has a re-issue path that does not involve
// the human authenticating again. A 12-hour handle over a 1-hour JWT would tell
// the UI a comfortable lie and then start 401ing from upstream at minute 61.
// Reporting the real ceiling is what lets the SPA warn before it happens.
//
// Consequence worth stating plainly: today the effective officer session is one
// hour and the citizen session thirty minutes, whatever
// EDGE_SESSION_ABSOLUTE_TTL_SECONDS says. Lengthening that needs an upstream
// credential-refresh road, which is an ADR-016 decision, not an edge tweak.
// ══════════════════════════════════════════════════════════════════

import { verifyAuthToken } from '@usrp/shared-auth';
import type { EdgeSession, SessionView } from '../domain/session.js';
import { projectSession } from '../domain/session.js';
import { mintCsrfToken, mintHandle } from '../domain/handle.js';
import type { EdgeSessionStore, SessionLookup } from '../ports/session-store.js';

export interface EdgeSessionServiceOptions {
  readonly idleTtlSeconds: number;
  readonly absoluteTtlSeconds: number;
  /** Issuer PUBLIC key — used to READ the officer token's claims, never to mint. */
  readonly authPublicKeyPem: string;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly now?: () => Date;
}

/** Everything a caller needs to answer a login: the cookies and the view. */
export interface IssuedSession {
  readonly handle: string;
  readonly csrfToken: string;
  readonly view: SessionView;
  /** Cookie Max-Age, bound to the ABSOLUTE ceiling. */
  readonly maxAgeSeconds: number;
}

export class EdgeSessionService {
  readonly #store: EdgeSessionStore;
  readonly #options: EdgeSessionServiceOptions;
  readonly #now: () => Date;

  constructor(store: EdgeSessionStore, options: EdgeSessionServiceOptions) {
    this.#store = store;
    this.#options = options;
    this.#now = options.now ?? ((): Date => new Date());
  }

  /**
   * Open an officer session from a freshly minted iam-service JWT.
   *
   * The token is VERIFIED here even though the edge just received it from the
   * issuer over a trusted link. Two reasons, both practical: the agency and
   * roles that go into the session must come from signed claims rather than
   * from anything a caller supplied, and a key/issuer/audience misconfiguration
   * is caught at first login instead of surfacing as unexplainable 401s from
   * three downstream services.
   */
  async openOfficerSession(token: string, credentialExpiresAt: Date): Promise<IssuedSession | null> {
    const principal = verifyAuthToken(this.#options.authPublicKeyPem, token, {
      now: this.#now(),
      expectedIssuer: this.#options.jwtIssuer,
      expectedAudience: this.#options.jwtAudience,
    });
    if (principal === null || principal.kind !== 'officer') {
      // iam-service issued something this edge cannot verify, or issued a
      // SYSTEM token on a human login route. Either is a platform fault, not a
      // credential rejection — it must not be reported to the browser as a
      // failed password.
      throw new Error(
        'iam-service returned a token this edge cannot verify as an officer principal ' +
          '(check AUTH_JWT_PUBLIC_KEY_B64 / JWT_ISSUER / JWT_AUDIENCE agreement).',
      );
    }
    const window = this.#window(credentialExpiresAt);
    if (window === null) return null;
    const session: EdgeSession = {
      kind: 'officer',
      credential: token,
      agency: principal.agency,
      roles: principal.roles,
      subjectId: principal.subjectId,
      credentialExpiresAt,
      idleExpiresAt: window.idleExpiresAt,
      absoluteExpiresAt: window.absoluteExpiresAt,
      csrfToken: mintCsrfToken(),
    };
    return this.#persist(session, window.maxAgeSeconds);
  }

  /** Open a citizen session from the opaque, revocable identity-service token. */
  async openApplicantSession(
    sessionToken: string,
    credentialExpiresAt: Date,
  ): Promise<IssuedSession | null> {
    const window = this.#window(credentialExpiresAt);
    if (window === null) return null;
    const session: EdgeSession = {
      kind: 'applicant',
      credential: sessionToken,
      credentialExpiresAt,
      idleExpiresAt: window.idleExpiresAt,
      absoluteExpiresAt: window.absoluteExpiresAt,
      csrfToken: mintCsrfToken(),
    };
    return this.#persist(session, window.maxAgeSeconds);
  }

  /** Resolve WITHOUT sliding — for reads that must not extend a session. */
  peek(handle: string): Promise<SessionLookup> {
    return this.#store.peek(handle);
  }

  /** Resolve AND slide the idle window. The absolute ceiling never moves. */
  touch(handle: string): Promise<SessionLookup> {
    return this.#store.touch(handle);
  }

  /** Destroy the handle. This is the ONLY officer revocation that exists. */
  destroy(handle: string): Promise<void> {
    return this.#store.destroy(handle);
  }

  healthy(): Promise<boolean> {
    return this.#store.healthy();
  }

  async #persist(session: EdgeSession, maxAgeSeconds: number): Promise<IssuedSession> {
    const handle = mintHandle();
    await this.#store.create(handle, session);
    return {
      handle,
      csrfToken: session.csrfToken,
      view: projectSession(session),
      maxAgeSeconds,
    };
  }

  /** The two expiries, clamped by the credential. null when already expired. */
  #window(credentialExpiresAt: Date): {
    readonly idleExpiresAt: Date;
    readonly absoluteExpiresAt: Date;
    readonly maxAgeSeconds: number;
  } | null {
    const nowMs = this.#now().getTime();
    const credentialMs = credentialExpiresAt.getTime();
    if (!Number.isFinite(credentialMs) || credentialMs <= nowMs) return null;
    const absoluteMs = Math.min(nowMs + this.#options.absoluteTtlSeconds * 1000, credentialMs);
    const idleMs = Math.min(nowMs + this.#options.idleTtlSeconds * 1000, absoluteMs);
    return {
      idleExpiresAt: new Date(idleMs),
      absoluteExpiresAt: new Date(absoluteMs),
      maxAgeSeconds: Math.max(1, Math.floor((absoluteMs - nowMs) / 1000)),
    };
  }
}
