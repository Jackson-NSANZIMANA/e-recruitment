// ══════════════════════════════════════════════════════════════════
// edge-gateway — Composition root
//
// Wires the store, the cipher, the upstream client and the limiter into the
// dependency bundle every route closes over, and exposes the pieces main() and
// the selfchecks both need. Keeping this separate from main.ts is what lets a
// selfcheck build the same object graph without a process, a signal handler or a
// listening socket.
// ══════════════════════════════════════════════════════════════════

import type { CorsPolicy, Route } from '@usrp/shared-http';
import { CSRF_HEADER } from './security/csrf.js';
import { cookiePolicy } from './security/cookies.js';
import { createCredentialCipher } from './security/credential-cipher.js';
import { FixedWindowRateLimiter } from './security/rate-limiter.js';
import { PgEdgeSessionStore } from './session/session-store.pg.js';
import { UpstreamClient } from './upstream/upstream-client.js';
import { edgeRoutes } from './routes.js';
import type { EdgeDeps } from './adapters/http/guards.js';
import { EDGE_SERVICE_NAME, loadEdgeGatewayConfig, type EdgeGatewayConfig } from './config.js';

export { EDGE_SERVICE_NAME, loadEdgeGatewayConfig, type EdgeGatewayConfig } from './config.js';
export {
  EDGE_OPERATIONS,
  EDGE_OPERATION_IDS,
  PUBLIC_ALLOWLIST,
  REACHABLE_UPSTREAM_IDS,
  edgeOperation,
  type EdgeOperation,
  type EdgeOperationId,
} from './registry/edge-operations.js';
export {
  BROKERED_SERVICE_INTERNAL,
  UPSTREAM,
  type UpstreamOperation,
  type UpstreamOperationId,
} from './registry/upstream-operations.js';
export { edgeHandlers, edgeRoutes } from './routes.js';
export { redact } from './observability/audit-log.js';
export { deriveCredentialKey } from './security/credential-cipher.js';
export { PgEdgeSessionStore } from './session/session-store.pg.js';
export { toSessionView, type EdgeSession, type SessionView } from './session/session.types.js';

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

export function createEdgeGateway(
  config: EdgeGatewayConfig = loadEdgeGatewayConfig(),
  now: () => Date = () => new Date(),
): EdgeGateway {
  const cipher = createCredentialCipher(config.session.handleHmacKey);
  const sessions = new PgEdgeSessionStore(
    {
      handleHmacKey: config.session.handleHmacKey,
      idleTtlSeconds: config.session.idleTtlSeconds,
      absoluteTtlSeconds: config.session.absoluteTtlSeconds,
    },
    cipher,
  );
  const deps: EdgeDeps = {
    config,
    cookies: cookiePolicy(config.session.secureCookies),
    sessions,
    upstream: new UpstreamClient(config.upstream),
    limiter: new FixedWindowRateLimiter(),
    now,
  };
  return { deps, routes: edgeRoutes(deps), cors: edgeCorsPolicy(config) };
}
