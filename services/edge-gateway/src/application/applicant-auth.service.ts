// ══════════════════════════════════════════════════════════════════
// edge-gateway — Applicant authentication use case
//
// Applicant OTP request, verification, and logout orchestration. Separated
// from the HTTP layer so auth logic can be tested without HTTP.
//
// Part of hexagonal architecture refactoring - application layer.
// ══════════════════════════════════════════════════════════════════

import type { SessionRepository } from '../ports/session-repository.js';
import type { UpstreamGateway } from '../ports/upstream-gateway.js';
import type { RateLimiter } from '../ports/rate-limiter.js';
import type { AuditLogger } from '../ports/audit-logger.js';
import { UPSTREAM } from '../domain/upstream-operations.js';
import { AuthenticationFailedError, RateLimitExceededError } from '../domain/edge.errors.js';

export interface RequestApplicantOtpCommand {
  readonly nationalId: string;
  readonly correlationId: string;
  readonly clientBucketKey: string;
}

export interface VerifyApplicantOtpCommand {
  readonly nationalId: string;
  readonly otp: string;
  readonly correlationId: string;
  readonly clientBucketKey: string;
}

export interface VerifyApplicantOtpResult {
  readonly sessionId: string;
  readonly handle: string;
  readonly csrfToken: string;
}

export interface ApplicantAuthConfig {
  readonly otpRequestRateLimit: number;
  readonly otpVerifyRateLimit: number;
}

export interface ApplicantAuthDeps {
  readonly sessions: SessionRepository;
  readonly upstream: UpstreamGateway;
  readonly limiter: RateLimiter;
  readonly audit: AuditLogger;
  readonly config: ApplicantAuthConfig;
}

/**
 * Applicant authentication use case. Handles applicant OTP flow (request and
 * verify) and logout without coupling to HTTP or transport layer.
 *
 * OTP request flow:
 *   1. Rate limit (per-client)
 *   2. Call upstream identity-service OTP request
 *   3. Return success/failure
 *
 * OTP verify flow:
 *   1. Rate limit (per-client)
 *   2. Call upstream identity-service OTP verify
 *   3. Create edge session if verification succeeds
 *   4. Emit audit event
 *
 * Logout flow:
 *   1. Call upstream identity-service logout (invalidate applicant session)
 *   2. Revoke edge session
 *   3. Emit audit event
 */
export class ApplicantAuthService {
  constructor(private readonly deps: ApplicantAuthDeps) {}

  /**
   * Request an OTP for an applicant. The edge forwards the national ID to
   * identity-service, which looks up the phone number and sends the OTP.
   *
   * @param command OTP request command
   * @returns Success indicator (always true if no exception)
   * @throws RateLimitExceededError if rate limit exceeded
   */
  async requestOtp(command: RequestApplicantOtpCommand): Promise<boolean> {
    // Per-client rate limiting
    const clientKey = `${command.clientBucketKey}:requestApplicantOtp`;
    const clientLimit = this.deps.limiter.check(clientKey, this.deps.config.otpRequestRateLimit);
    if (!clientLimit.allowed) {
      throw new RateLimitExceededError(clientLimit.retryAfterSeconds);
    }

    // Call upstream identity-service
    const upstream = await this.deps.upstream.call({
      operation: UPSTREAM.otpRequest,
      correlationId: command.correlationId,
      body: {
        nationalId: command.nationalId,
      },
    });

    // 200 or 400/404 both result in "OTP sent" response to prevent enumeration
    return upstream.status === 200 || upstream.status === 400 || upstream.status === 404;
  }

  /**
   * Verify an OTP and create an applicant session. The edge forwards the
   * national ID and OTP to identity-service, which verifies them and returns
   * an applicant session handle. The edge wraps that handle in its own session.
   *
   * @param command OTP verification command
   * @param now Current time
   * @returns Session handle and CSRF token (for cookies)
   * @throws RateLimitExceededError if rate limit exceeded
   * @throws AuthenticationFailedError if OTP invalid
   */
  async verifyOtp(command: VerifyApplicantOtpCommand, now: Date): Promise<VerifyApplicantOtpResult> {
    // Per-client rate limiting
    const clientKey = `${command.clientBucketKey}:verifyApplicantOtp`;
    const clientLimit = this.deps.limiter.check(clientKey, this.deps.config.otpVerifyRateLimit);
    if (!clientLimit.allowed) {
      throw new RateLimitExceededError(clientLimit.retryAfterSeconds);
    }

    // Call upstream identity-service
    const upstream = await this.deps.upstream.call({
      operation: UPSTREAM.otpVerify,
      correlationId: command.correlationId,
      body: {
        nationalId: command.nationalId,
        otp: command.otp,
      },
    });

    // 400 and 401 both mean invalid OTP
    if (upstream.status !== 200) {
      throw new AuthenticationFailedError();
    }

    // Extract applicant session handle from response
    const applicantSessionHandle = this.extractField(upstream.body, 'sessionHandle', 'string');

    // Create edge session
    const issued = await this.deps.sessions.create(
      {
        kind: 'applicant',
        subjectId: null, // Edge never learns applicant id (ADR-014)
        agency: null, // Applicants are cross-agency
        roles: [],
        upstreamCredential: applicantSessionHandle,
        upstreamExpiresAt: null,
      },
      now
    );

    // Audit
    this.deps.audit.log({
      action: 'EDGE_SESSION_ISSUED',
      operationId: 'verifyApplicantOtp',
      correlationId: command.correlationId,
      sessionId: issued.session.sessionId,
      sessionKind: 'applicant',
    });

    return {
      sessionId: issued.session.sessionId,
      handle: issued.handle,
      csrfToken: issued.csrfToken,
    };
  }

  /**
   * Applicant logout: invalidate the applicant session upstream, then revoke
   * the edge session.
   *
   * @param upstreamCredential The applicant session handle (for upstream logout)
   * @param sessionId The edge session to revoke
   * @param correlationId Correlation id for audit
   * @param now Current time
   */
  async logout(
    upstreamCredential: string,
    sessionId: string,
    correlationId: string,
    now: Date
  ): Promise<void> {
    // Call upstream identity-service to invalidate applicant session
    await this.deps.upstream.call({
      operation: UPSTREAM.applicantLogout,
      correlationId,
      credential: upstreamCredential,
    });

    // Revoke edge session
    await this.deps.sessions.revoke(sessionId, 'applicant_logout', now);

    this.deps.audit.log({
      action: 'EDGE_SESSION_DESTROYED',
      operationId: 'logoutApplicant',
      correlationId,
      sessionId,
      reason: 'applicant_logout',
    });
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
}
