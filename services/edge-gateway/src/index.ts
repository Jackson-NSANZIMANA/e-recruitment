// ══════════════════════════════════════════════════════════════════
// edge-gateway — Composition root
//
// The ONLY file that knows which adapter implements which port. Guards,
// controllers and use cases are typed on ports (EdgeDeps, declared once in
// adapters/http/guards.ts).
//
// LAYERING (dependency arrows point inward, and the hygiene proof pins them):
//
//   adapters/http/*   → ports, domain, crypto      (driving side)
//   adapters/*.ts     → ports, domain, crypto      (driven side; never adapters/http)
//   application/*     → ports, domain              (only where there is real orchestration)
//   domain/*, crypto/ → nothing in this service
//
// A simple brokered operation is controller → UpstreamGateway port. Only an
// operation with orchestration of its own gets an application-layer use case.
// That is a deliberate rule, not an omission: a pass-through "service" for every
// route is ceremony that hides where the decisions actually are.
//
// Keeping this separate from main.ts is what lets selfchecks build the same
// object graph without a process, a signal handler, or a listening socket.
// ══════════════════════════════════════════════════════════════════

import type { CorsPolicy, Route } from '@usrp/shared-http';
import { CSRF_HEADER } from './adapters/http/csrf.js';
import { cookiePolicy } from './adapters/http/cookies.js';
import type { EdgeDeps } from './adapters/http/guards.js';
import { edgeRoutes } from './routes.js';
import { loadEdgeGatewayConfig, type EdgeGatewayConfig } from './config.js';
import { PgEdgeSessionStore } from './adapters/session-store.pg-repository.js';
import { UpstreamClient } from './adapters/upstream.http-gateway.js';
import { InMemoryRateLimiter } from './adapters/rate-limiter.memory.js';
import { createCredentialCipher } from './adapters/credential-cipher.adapter.js';
import { createAuditLogger } from './adapters/audit-logger.adapter.js';
import type { AuditLogger } from './ports/audit-logger.js';

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
export { edgeHandlers, edgeRoutes } from './routes.js';
export { redact, summariseError, StdoutAuditLogger, createAuditLogger } from './adapters/audit-logger.adapter.js';
export { PgEdgeSessionStore } from './adapters/session-store.pg-repository.js';
export { UpstreamClient } from './adapters/upstream.http-gateway.js';
export { InMemoryRateLimiter } from './adapters/rate-limiter.memory.js';
export { createCredentialCipher, deriveCredentialKey } from './adapters/credential-cipher.adapter.js';
export type { EdgeDeps } from './adapters/http/guards.js';
export type { SessionRepository, RotatedSession } from './ports/session-repository.js';
export type { UpstreamGateway } from './ports/upstream-gateway.js';
export type { RateLimiter } from './ports/rate-limiter.js';
export type { CredentialCipher } from './ports/credential-cipher.js';
export type { AuditLogger, EdgeAuditRecord, EdgeFaultRecord } from './ports/audit-logger.js';

export interface EdgeGateway {
  readonly deps: EdgeDeps;
  readonly routes: readonly Route[];
  readonly cors: CorsPolicy;
}

/**
 * The cross-origin policy.
 *
 * EXACT-MATCH ORIGINS ONLY, and `credentials: true`: browsers refuse `*` on a
 * credentialed request, and the credential here travels as a cookie.
 * `x-csrf-token` must be allowed or every unsafe request fails preflight, and
 * `x-correlation-id` must be allowed or one click stops being one trace.
 */
export function edgeCorsPolicy(config: EdgeGatewayConfig): CorsPolicy {
  return {
    origins: config.cors.origins,
    credentials: true,
    // No PATCH, no DELETE: no route in this platform accepts either verb.
    allowedMethods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', CSRF_HEADER, 'x-correlation-id'],
    exposedHeaders: ['x-request-id', 'x-correlation-id'],
    preflightMaxAgeSeconds: 600,
  };
}

export interface EdgeGatewayOverrides {
  /** Inject a recording sink in proofs. Defaults to the redacting stdout logger. */
  readonly audit?: AuditLogger;
}

/** Compose the edge gateway: adapters → (use cases) → controllers. */
export function createEdgeGateway(
  config: EdgeGatewayConfig = loadEdgeGatewayConfig(),
  now: () => Date = () => new Date(),
  overrides: EdgeGatewayOverrides = {},
): EdgeGateway {
  const hmacKey = config.session.handleHmacKey;
  const audit = overrides.audit ?? createAuditLogger();
  const cipher = createCredentialCipher(hmacKey);

  const sessions = new PgEdgeSessionStore(
    {
      handleHmacKey: hmacKey,
      idleTtlSeconds: config.session.idleTtlSeconds,
      absoluteTtlSeconds: config.session.absoluteTtlSeconds,
    },
    cipher,
    audit,
  );
  const upstream = new UpstreamClient(config.upstream);
  // Per-process in this PR, behind the async port. The shared Postgres limiter
  // lands in PR-4 together with its migration and its proof.
  const limiter = new InMemoryRateLimiter(() => now().getTime());

  const deps: EdgeDeps = {
    config,
    cookies: cookiePolicy(config.session.secureCookies),
    sessions,
    upstream,
    limiter,
    audit,
    now,
  };

  return { deps, routes: edgeRoutes(deps), cors: edgeCorsPolicy(config) };
}
