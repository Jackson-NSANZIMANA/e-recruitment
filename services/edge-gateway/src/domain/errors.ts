// ══════════════════════════════════════════════════════════════════
// edge-gateway — Domain errors
//
// Only genuinely exceptional conditions throw. Business outcomes (no
// session, wrong kind, rejected credential) are RETURN VALUES, because each
// one has a specific response body the contract pins down and an exception
// would flatten them all into the transport's generic error shape.
// ══════════════════════════════════════════════════════════════════

/** The session store is unreachable/broken. Renders 503, never 500-with-detail. */
export class SessionStoreError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'SessionStoreError';
  }
}

/**
 * An upstream service could not be reached or answered unusably.
 * `authority` names the G2G dependency when the upstream said which — those
 * codes are safe to pass to a browser and worth passing ("the national ID
 * service is unavailable, try shortly" is actionable; "something went wrong"
 * is not).
 */
export class UpstreamError extends Error {
  readonly authority: string;
  constructor(authority: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'UpstreamError';
    this.authority = authority;
  }
}

/**
 * The upstream refused the credential the edge is holding.
 *
 * This is how upstream revocation and upstream expiry REACH THE BROWSER.
 * ADR-018 chose a revocable citizen token specifically so a stolen session
 * could be killed; if the edge answered a 401 from identity-service with a
 * generic 500, the kill would have no visible effect and the property would be
 * worth nothing. The handler destroys the handle and reports `reason`, so the
 * next request is a clean anonymous one and the UI can explain itself.
 */
export class UpstreamCredentialRejected extends Error {
  /** 'revoked' when upstream killed it; 'absolute' when it simply expired. */
  readonly reason: 'revoked' | 'absolute';
  constructor(reason: 'revoked' | 'absolute') {
    super(`The upstream credential was rejected (${reason}).`);
    this.name = 'UpstreamCredentialRejected';
    this.reason = reason;
  }
}
