// ══════════════════════════════════════════════════════════════════
// edge-gateway — Domain errors
//
// Domain-specific error types representing business rule violations and
// expected failure modes. These are used by the application layer and
// mapped to HTTP status codes by the adapters.
//
// Part of hexagonal architecture refactoring - domain layer.
// ══════════════════════════════════════════════════════════════════

/**
 * The session handle does not resolve to any session in the store.
 * Maps to 401 at the HTTP layer.
 */
export class SessionNotFoundError extends Error {
  constructor(message = 'Session not found') {
    super(message);
    this.name = 'SessionNotFoundError';
  }
}

/**
 * The session exists but has passed its idle or absolute TTL.
 * Maps to 401 at the HTTP layer.
 */
export class SessionExpiredError extends Error {
  constructor(message = 'Session has expired') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/**
 * The session was explicitly revoked (logout or admin action).
 * Maps to 401 at the HTTP layer.
 */
export class SessionRevokedError extends Error {
  constructor(
    public readonly reason: string | null = null,
    message = 'Session has been revoked'
  ) {
    super(message);
    this.name = 'SessionRevokedError';
  }
}

/**
 * Rate limit exceeded for the given bucket (per-client or per-target).
 * Maps to 429 at the HTTP layer with Retry-After header.
 */
export class RateLimitExceededError extends Error {
  constructor(
    public readonly retryAfterSeconds: number,
    message = 'Rate limit exceeded'
  ) {
    super(message);
    this.name = 'RateLimitExceededError';
  }
}

/**
 * Credential verification failed (wrong password, unknown handle, etc.).
 * Maps to 401 at the HTTP layer.
 */
export class AuthenticationFailedError extends Error {
  constructor(message = 'Authentication failed') {
    super(message);
    this.name = 'AuthenticationFailedError';
  }
}

/**
 * CSRF token validation failed.
 * Maps to 403 at the HTTP layer.
 */
export class CsrfValidationError extends Error {
  constructor(message = 'CSRF token validation failed') {
    super(message);
    this.name = 'CsrfValidationError';
  }
}

/**
 * A named upstream dependency is unavailable or returned 5xx.
 * Maps to 503 at the HTTP layer with the G2G error code.
 */
export class UpstreamUnavailableError extends Error {
  constructor(
    public readonly code: string,
    public readonly upstreamOperationId: string,
    cause?: unknown
  ) {
    super(`Upstream ${upstreamOperationId} unavailable (${code})`, { cause });
    this.name = 'UpstreamUnavailableError';
  }
}

/**
 * The upstream returned a response that does not match the expected contract.
 * Maps to 502 at the HTTP layer.
 */
export class UpstreamContractMismatchError extends Error {
  constructor(
    public readonly upstreamOperationId: string,
    public readonly detail: string,
    message = 'Upstream contract mismatch'
  ) {
    super(message);
    this.name = 'UpstreamContractMismatchError';
  }
}
