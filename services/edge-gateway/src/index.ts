// ══════════════════════════════════════════════════════════════════
// edge-gateway — Composition root
//
// Wires the hexagonal architecture layers: creates infrastructure adapters,
// injects them into application services, and assembles the dependency bundle
// for HTTP controllers. This is the single place where the entire object graph
// is composed, making dependencies explicit and testable.
//
// Hexagonal architecture layers (dependency direction: inward):
//   adapters → ports → application → domain
//
// Keeping this separate from main.ts is what lets selfchecks build the same
// object graph without a process, a signal handler, or a listening socket.
// ══════════════════════════════════════════════════════════════════

import type { CorsPolicy, Route } from '@usrp/shared-http';
import { CSRF_HEADER } from './security/csrf.js';
import { cookiePolicy, type CookiePolicy } from './security/cookies.js';
import { edgeRoutes } from './routes.js';
import { EDGE_SERVICE_NAME, loadEdgeGatewayConfig, type EdgeGatewayConfig } from './config.js';

// Domain
export {
  EDGE_SERVICE_NAME,
  loadEdgeGatewayConfig,
  type EdgeGatewayConfig,
} from './config.js';
export {
  EDGE_OPERATIONS,
  EDGE_OPERATION_IDS,
  PUBLIC_ALLOWLIST,
  REACHABLE_UPSTREAM_IDS,
  edgeOperation,
  type EdgeOperation,
  type EdgeOperationId,
} from './domain/edge-operations.js';
export {
  BROKERED_SERVICE_INTERNAL,
  UPSTREAM,
  type UpstreamOperation,
  type UpstreamOperationId,
} from './domain/upstream-operations.js';
export { toSessionView, type EdgeSession, type SessionView } from './domain/session.types.js';

// Application Services
export type { SessionManagementService } from './application/session-management.service.js';
export type { OfficerAuthService } from './application/officer-auth.service.js';
export type { ApplicantAuthService } from './application/applicant-auth.service.js';
export type { UpstreamProxyService } from './application/upstream-proxy.service.js';

// Adapters (exports for external use)
export { PgEdgeSessionStore } from './adapters/session-store.pg-repository.js';
export { UpstreamClient } from './adapters/upstream.http-gateway.js';
export { FixedWindowRateLimiter } from './adapters/fixed-window-rate-limiter.js';
export { createCredentialCipher, deriveCredentialKey } from './adapters/credential-cipher.adapter.js';
export { createAuditLogger, redact, auditEdge, auditEdgeStats } from './adapters/audit-logger.adapter.js';

// Routes
export { edgeHandlers, edgeRoutes } from './routes.js';

// Ports (for testing and extension)
export type { SessionRepository } from './ports/session-repository.js';
export type { UpstreamGateway } from './ports/upstream-gateway.js';
export type { RateLimiter } from './ports/rate-limiter.js';
export type { CredentialCipher } from './ports/credential-cipher.js';
export type { AuditLogger } from './ports/audit-logger.js';

// Import implementations
import { SessionManagementService } from './application/session-management.service.js';
import { OfficerAuthService } from './application/officer-auth.service.js';
import { ApplicantAuthService } from './application/applicant-auth.service.js';
import { UpstreamProxyService } from './application/upstream-proxy.service.js';

import { PgEdgeSessionStore } from './adapters/session-store.pg-repository.js';
import { UpstreamClient } from './adapters/upstream.http-gateway.js';
import { FixedWindowRateLimiter } from './adapters/fixed-window-rate-limiter.js';
import { createCredentialCipher } from './adapters/credential-cipher.adapter.js';
import { createAuditLogger } from './adapters/audit-logger.adapter.js';

/**
 * The dependency bundle every edge route closes over. Contains both application
 * services (for business logic) and infrastructure (for guards and middleware).
 */
export interface EdgeDeps {
  readonly config: EdgeGatewayConfig;
  readonly cookies: CookiePolicy;

  // Application Services
  readonly sessionManagement: SessionManagementService;
  readonly officerAuth: OfficerAuthService;
  readonly applicantAuth: ApplicantAuthService;
  readonly upstreamProxy: UpstreamProxyService;

  // Infrastructure (for guards, middleware, and backwards compatibility)
  readonly sessions: PgEdgeSessionStore;
  readonly upstream: UpstreamClient;
  readonly limiter: FixedWindowRateLimiter;

  readonly now: () => Date;
}

export interface EdgeGateway {
  readonly deps: EdgeDeps;
  readonly routes: readonly Route[];
  readonly cors: CorsPolicy;
}

/**
 * The cross-origin policy.
 *
 * EXACT-MATCH ORIGINS ONLY, and `credentials: true` — which is exactly why a
 * wildcard is impossible here: browsers refuse `*` on a credentialed request,
 * and the whole point of this tier is that the credential travels as a cookie.
 *
 * `x-csrf-token` must be in allowedHeaders or every unsafe request fails
 * preflight, and `x-correlation-id` must be there or one click stops being one
 * trace. Both are exposed back so the SPA can read the ids off a response it is
 * reporting on.
 */
export function edgeCorsPolicy(config: EdgeGatewayConfig): CorsPolicy {
  return {
    origins: config.cors.origins,
    credentials: true,
    // No PATCH, no DELETE. Not an omission — no route in this platform accepts
    // either verb, and advertising them would invite the generic status write
    // ADR-021 rejects.
    allowedMethods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', CSRF_HEADER, 'x-correlation-id'],
    exposedHeaders: ['x-request-id', 'x-correlation-id'],
    preflightMaxAgeSeconds: 600,
  };
}

/**
 * Compose the edge gateway: wire adapters → application services → controllers.
 *
 * This is the hexagonal architecture's composition root. Every dependency is
 * created here and injected, making the architecture explicit and testable.
 *
 * @param config Edge gateway configuration (defaults to loadEdgeGatewayConfig)
 * @param now Clock function for testing (defaults to () => new Date())
 * @returns Composed EdgeGateway with routes and CORS policy
 */
export function createEdgeGateway(
  config: EdgeGatewayConfig = loadEdgeGatewayConfig(),
  now: () => Date = () => new Date(),
): EdgeGateway {
  // ──────────────────────────────────────────────────────────────────
  // Layer 1: Infrastructure Adapters (Ports Implementations)
  // ──────────────────────────────────────────────────────────────────

  const cipher = createCredentialCipher(config.session.handleHmacKey);

  const sessions = new PgEdgeSessionStore(
    {
      handleHmacKey: config.session.handleHmacKey,
      idleTtlSeconds: config.session.idleTtlSeconds,
      absoluteTtlSeconds: config.session.absoluteTtlSeconds,
    },
    cipher,
  );

  const upstream = new UpstreamClient(config.upstream);
  const limiter = new FixedWindowRateLimiter();
  const audit = createAuditLogger();

  // ──────────────────────────────────────────────────────────────────
  // Layer 2: Application Services (Use Cases)
  // ──────────────────────────────────────────────────────────────────

  const sessionManagement = new SessionManagementService({
    repository: sessions,
    cipher,
    audit,
  });

  const officerAuth = new OfficerAuthService({
    sessions,
    upstream,
    limiter,
    audit,
    cipher,
    config: {
      authPublicKeyPem: config.auth.authPublicKeyPem,
      jwtIssuer: config.auth.jwtIssuer,
      jwtAudience: config.auth.jwtAudience,
      handleHmacKey: config.session.handleHmacKey,
      loginRateLimit: config.rateLimits.loginPerMinute,
    },
  });

  const applicantAuth = new ApplicantAuthService({
    sessions,
    upstream,
    limiter,
    audit,
    config: {
      otpRequestRateLimit: config.rateLimits.otpPerMinute,
      otpVerifyRateLimit: config.rateLimits.otpPerMinute,
    },
  });

  const upstreamProxy = new UpstreamProxyService({ upstream });

  // ──────────────────────────────────────────────────────────────────
  // Layer 3: HTTP Layer Dependencies (Controllers)
  // ──────────────────────────────────────────────────────────────────

  const deps: EdgeDeps = {
    config,
    cookies: cookiePolicy(config.session.secureCookies),
    sessionManagement,
    officerAuth,
    applicantAuth,
    upstreamProxy,
    sessions,
    upstream,
    limiter,
    now,
  };

  return {
    deps,
    routes: edgeRoutes(deps),
    cors: edgeCorsPolicy(config),
  };
}
