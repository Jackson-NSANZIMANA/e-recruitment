// ══════════════════════════════════════════════════════════════════
// edge-gateway — Session management use case
//
// Core session lifecycle operations: read, refresh, and revoke. Separated from
// the HTTP layer so session logic can be tested without HTTP, reused across
// different transports, and reasoned about as pure business rules.
//
// Part of hexagonal architecture refactoring - application layer.
// ══════════════════════════════════════════════════════════════════

import type { SessionRepository } from '../ports/session-repository.js';
import type { CredentialCipher } from '../ports/credential-cipher.js';
import type { AuditLogger } from '../ports/audit-logger.js';
import type { SessionView } from '../domain/session.types.js';
import { toSessionView } from '../domain/session.types.js';
import {
  SessionNotFoundError,
  SessionExpiredError,
  SessionRevokedError,
  CsrfValidationError,
} from '../domain/edge.errors.js';

export interface SessionManagementDeps {
  readonly repository: SessionRepository;
  readonly cipher: CredentialCipher;
  readonly audit: AuditLogger;
}

/**
 * Session management use case. Handles session lifecycle operations without
 * coupling to HTTP, cookies, or any transport layer.
 *
 * The service validates sessions (expiry, revocation), enforces CSRF protection,
 * and emits audit events for security-relevant actions.
 */
export class SessionManagementService {
  constructor(private readonly deps: SessionManagementDeps) {}

  /**
   * Read a session by its handle. Returns the browser-facing view (no credential)
   * if the session is active, or null if no such handle. Throws if the session
   * exists but is expired or revoked.
   *
   * This is GET /edge/v1/session: the browser's only way to learn what session
   * it holds.
   *
   * @param handle Cleartext session handle (from cookie)
   * @param now Current time
   * @returns Session view or null
   * @throws SessionExpiredError if the session has expired
   * @throws SessionRevokedError if the session was revoked
   */
  async readSession(handle: string, now: Date): Promise<SessionView | null> {
    const handleHash = this.deps.cipher.hashHandle(handle);
    const lookup = await this.deps.repository.findByHandle(handleHash, now);

    if (lookup.kind === 'UNKNOWN') {
      return null;
    }

    if (lookup.kind === 'ENDED') {
      if (lookup.reason === 'revoked') {
        throw new SessionRevokedError(lookup.reason);
      }
      throw new SessionExpiredError();
    }

    return toSessionView(lookup.session);
  }

  /**
   * Refresh a session: validate the CSRF token, advance the idle TTL, and issue
   * a new CSRF token. This is POST /edge/v1/session/refresh: the only way to
   * keep an idle session alive without making an authenticated request.
   *
   * The new CSRF token is returned so the browser can replace the old one. The
   * session handle stays the same (it lives in the cookie and is httpOnly).
   *
   * @param handle Cleartext session handle (from cookie)
   * @param csrfToken CSRF token to validate
   * @param now Current time
   * @returns Refreshed session view and new CSRF token
   * @throws SessionNotFoundError if no such handle
   * @throws SessionRevokedError if the session was revoked
   * @throws SessionExpiredError if the session has expired
   * @throws CsrfValidationError if the CSRF token is invalid
   */
  async refreshSession(
    handle: string,
    csrfToken: string,
    now: Date
  ): Promise<{ session: SessionView; newCsrfToken: string }> {
    const handleHash = this.deps.cipher.hashHandle(handle);
    const lookup = await this.deps.repository.findByHandle(handleHash, now);

    if (lookup.kind === 'UNKNOWN') {
      throw new SessionNotFoundError();
    }

    if (lookup.kind === 'ENDED') {
      if (lookup.reason === 'revoked') {
        throw new SessionRevokedError(lookup.reason);
      }
      throw new SessionExpiredError();
    }

    const session = lookup.session;

    // Validate CSRF token. The token is deterministic (derived from session id),
    // so we regenerate the expected token and compare.
    const expectedCsrf = this.deps.cipher.generateCsrfToken(session.sessionId);
    const csrfHash = this.deps.cipher.hashCsrfToken(csrfToken);

    // Compare both current and previous hash (supports token rotation).
    if (
      csrfHash !== session.csrfTokenHash &&
      csrfHash !== session.previousCsrfTokenHash
    ) {
      throw new CsrfValidationError();
    }

    // Touch the session (advance idle TTL).
    await this.deps.repository.touch(session.sessionId, now);

    // Generate new CSRF token.
    const newCsrfToken = this.deps.cipher.generateCsrfToken(session.sessionId);

    return {
      session: toSessionView(session),
      newCsrfToken,
    };
  }

  /**
   * Revoke a session (logout or admin action). The session row stays in the
   * database for audit but will not resolve to ACTIVE anymore.
   *
   * @param sessionId The session's database id
   * @param reason Why the session was revoked (e.g., 'officer_logout')
   * @param now Current time
   */
  async revokeSession(sessionId: string, reason: string, now: Date): Promise<void> {
    await this.deps.repository.revoke(sessionId, reason, now);

    this.deps.audit.log({
      action: 'EDGE_SESSION_DESTROYED',
      sessionId,
      reason,
      timestamp: now,
    });
  }

  /**
   * Get a session by handle for use in application services (returns the full
   * session with credential, not the browser view). Used internally by auth
   * services to resolve sessions for upstream calls.
   *
   * @param handle Cleartext session handle
   * @param now Current time
   * @returns Full session or null
   * @throws SessionExpiredError if the session has expired
   * @throws SessionRevokedError if the session was revoked
   */
  async getSessionByHandle(handle: string, now: Date) {
    const handleHash = this.deps.cipher.hashHandle(handle);
    const lookup = await this.deps.repository.findByHandle(handleHash, now);

    if (lookup.kind === 'UNKNOWN') {
      return null;
    }

    if (lookup.kind === 'ENDED') {
      if (lookup.reason === 'revoked') {
        throw new SessionRevokedError(lookup.reason);
      }
      throw new SessionExpiredError();
    }

    return lookup.session;
  }
}
