// ══════════════════════════════════════════════════════════════════
// edge-gateway — Officer authentication use case
//
// Officer login and logout orchestration: rate limiting, upstream IAM call,
// token verification, session creation, and audit logging. Separated from
// the HTTP layer so auth logic can be tested without HTTP.
//
// Part of hexagonal architecture refactoring - application layer.
// ══════════════════════════════════════════════════════════════════

import { verifyAuthToken } from '@usrp/shared-auth';
import type { SessionRepository } from '../ports/session-repository.js';
import type { UpstreamGateway } from '../ports/upstream-gateway.js';
import type { RateLimiter } from '../ports/rate-limiter.js';
import type { AuditLogger } from '../ports/audit-logger.js';
import type { CredentialCipher } from '../ports/credential-cipher.js';
import { UPSTREAM } from '../domain/upstream-operations.js';
import {
  AuthenticationFailedError,
  RateLimitExceededError,
  UpstreamContractMismatchError,
} from '../domain/edge.errors.js';

export interface OfficerLoginCommand {
  readonly loginHandle: string;
  readonly password: string;
  readonly correlationId: string;
  readonly clientBucketKey: string;
}

export interface OfficerLoginResult {
  readonly sessionId: string;
  readonly handle: string;
  readonly csrfToken: string;
}

export interface OfficerAuthConfig {
  readonly authPublicKeyPem: string;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly handleHmacKey: string;
  readonly loginRateLimit: number;
}

export interface OfficerAuthDeps {
  readonly sessions: SessionRepository;
  readonly upstream: UpstreamGateway;
  readonly limiter: RateLimiter;
  readonly audit: AuditLogger;
  readonly cipher: CredentialCipher;
  readonly config: OfficerAuthConfig;
}

/**
 * Officer authentication use case. Handles officer login and logout without
 * coupling to HTTP, cookies, or any transport layer.
 *
 * Login flow:
 *   1. Rate limit (per-client and per-target)
 *   2. Call upstream iam-service
 *   3. Verify returned JWT
 *   4. Create edge session
 *   5. Emit audit event
 *
 * Logout flow:
 *   1. Revoke session
 *   2. Emit audit event
 */
export class OfficerAuthService {
  constructor(private readonly deps: OfficerAuthDeps) {}

  /**
   * Officer login: exchange credentials for an edge session. The edge forwards
   * the credentials to iam-service, verifies the returned JWT, stores it in a
   * session, and returns the session handle and CSRF token.
   *
   * @param command Login command
   * @param now Current time
   * @returns Session handle and CSRF token (for cookies)
   * @throws RateLimitExceededError if rate limit exceeded
   * @throws AuthenticationFailedError if credentials invalid
   * @throws UpstreamContractMismatchError if iam-service returns invalid token
   */
  async login(command: OfficerLoginCommand, now: Date): Promise<OfficerLoginResult> {
    // Per-target rate limiting: prevent credential stuffing against one account
    const targetKey = this.targetBucketKey(command.loginHandle);
    const targetLimit = this.deps.limiter.check(targetKey, this.deps.config.loginRateLimit);
    if (!targetLimit.allowed) {
      throw new RateLimitExceededError(targetLimit.retryAfterSeconds);
    }

    // Per-client rate limiting: prevent distributed stuffing from one IP
    const clientKey = `${command.clientBucketKey}:officerLogin`;
    const clientLimit = this.deps.limiter.check(clientKey, this.deps.config.loginRateLimit);
    if (!clientLimit.allowed) {
      throw new RateLimitExceededError(clientLimit.retryAfterSeconds);
    }

    // Call upstream IAM
    const upstream = await this.deps.upstream.call({
      operation: UPSTREAM.officerLogin,
      correlationId: command.correlationId,
      body: {
        loginHandle: command.loginHandle,
        password: command.password,
      },
    });

    // 400 and 401 both mean bad credentials
    if (upstream.status !== 200) {
      throw new AuthenticationFailedError();
    }

    // Extract and validate token
    const token = this.extractField(upstream.body, 'token', 'string');
    const expiresAt = this.extractOptionalField(upstream.body, 'expiresAt', 'string');

    if (token.length === 0) {
      throw new UpstreamContractMismatchError(
        UPSTREAM.officerLogin.id,
        'Token field is empty'
      );
    }

    // Verify token
    const principal = verifyAuthToken(this.deps.config.authPublicKeyPem, token, {
      now,
      expectedIssuer: this.deps.config.jwtIssuer,
      expectedAudience: this.deps.config.jwtAudience,
    });

    if (principal === null || principal.kind !== 'officer') {
      throw new UpstreamContractMismatchError(
        UPSTREAM.officerLogin.id,
        'Token does not verify as officer principal'
      );
    }

    // Create session
    const issued = await this.deps.sessions.create(
      {
        kind: 'officer',
        subjectId: principal.subjectId,
        agency: principal.agency,
        roles: principal.roles,
        upstreamCredential: token,
        upstreamExpiresAt: expiresAt,
      },
      now
    );

    // Audit
    this.deps.audit.log({
      action: 'EDGE_SESSION_ISSUED',
      operationId: 'officerLogin',
      correlationId: command.correlationId,
      sessionId: issued.session.sessionId,
      subjectId: principal.subjectId,
      agency: principal.agency,
      sessionKind: 'officer',
    });

    return {
      sessionId: issued.session.sessionId,
      handle: issued.handle,
      csrfToken: issued.csrfToken,
    };
  }

  /**
   * Officer logout: revoke the session. The session row stays in the database
   * for audit but will not resolve to ACTIVE anymore.
   *
   * @param sessionId The session to revoke
   * @param correlationId Correlation id for audit
   * @param now Current time
   */
  async logout(sessionId: string, correlationId: string, now: Date): Promise<void> {
    await this.deps.sessions.revoke(sessionId, 'officer_logout', now);

    this.deps.audit.log({
      action: 'EDGE_SESSION_DESTROYED',
      operationId: 'officerLogout',
      correlationId,
      sessionId,
      reason: 'officer_logout',
    });
  }

  private targetBucketKey(loginHandle: string): string {
    // Hash the login handle so rate limit bucket keys don't leak handles
    const hash = this.deps.cipher.hashHandle(loginHandle.toLowerCase());
    return `target:${hash}:officerLogin`;
  }

  private extractField(body: unknown, field: string, type: string): string {
    if (typeof body !== 'object' || body === null) {
      throw new Error(`Expected object body, got ${typeof body}`);
    }
    const value = (body as Record<string, unknown>)[field];
    if (typeof value !== type) {
      throw new Error(`Expected ${field} to be ${type}, got ${typeof value}`);
    }
    return value as string;
  }

  private extractOptionalField(body: unknown, field: string, type: string): string | null {
    if (typeof body !== 'object' || body === null) {
      return null;
    }
    const value = (body as Record<string, unknown>)[field];
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== type) {
      return null;
    }
    return value as string;
  }
}
