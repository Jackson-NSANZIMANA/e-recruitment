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
import { PgRateLimiter } from './adapters/rate-limiter.pg.js';
import { createCredentialCipher } from './adapters/credential-cipher.adapter.js';
import { createAuditLogger } from './adapters/audit-logger.adapter.js';
import type { AuditLogger } from './ports/audit-logger.js';
import type { RateLimiter } from './ports/rate-limiter.js';

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
export { PgRateLimiter, type PgRateLimiterOptions } from './adapters/rate-limiter.pg.js';
export { createCredentialCipher, deriveCredentialKey } from './adapters/credential-cipher.adapter.js';
export type { EdgeDeps } from './adapters/http/guards.js';
export type { SessionRepository, RotatedSession } from './ports/session-repository.js';
export type { UpstreamGateway } from './ports/upstream-gateway.js';
export type { RateLimiter } from './ports/rate-limiter.js';
export type { CredentialCipher } from './ports/credential-cipher.js';
export type { AuditLogger, EdgeAuditRecord, EdgeFaultRecord } from './ports/audit-logger.js';
export * from './application/index.js';

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
 *
 * `Idempotency-Replayed` is exposed (ADR-027) because a browser cannot read
 * an unlisted response header — without this entry a replayed submission
 * would be indistinguishable from a first one IN THE SPA, defeating the one
 * purpose of the header. It is an explicit allowlisted name, not a wildcard:
 * no other upstream header becomes readable by extension.
 */
export function edgeCorsPolicy(config: EdgeGatewayConfig): CorsPolicy {
  return {
    origins: config.cors.origins,
    credentials: true,
    // No PATCH, no DELETE: no route in this platform accepts either verb.
    allowedMethods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', CSRF_HEADER, 'x-correlation-id', 'idempotency-key'],
    exposedHeaders: ['x-request-id', 'x-correlation-id', 'Idempotency-Replayed'],
    preflightMaxAgeSeconds: 600,
  };
}

/**
 * The production boot guard for the rate-limit store.
 *
 * The in-memory limiter is PER-PROCESS: N replicas would permit N times every
 * configured rate on exactly the operations where the limit is a correctness
 * control (login, OTP, NIDA, citizen submission). Production must run the
 * shared Postgres store (rate-limiter.pg.ts over rls/0024); a production
 * boot configured for memory is refused here, before a single request is
 * served — the same posture as the secure-cookie refusal in main.ts.
 */
export function assertRateLimitStoreAllowed(
  isProduction: boolean,
  store: RateLimiter['store'],
): void {
  if (isProduction && store !== 'postgres') {
    throw new Error(
      'Edge rate limiting would run in-memory in production. The per-process limiter lets N replicas permit N times every configured rate — including the applicant-submission cap — so the shared Postgres store (adapters/rate-limiter.pg.ts, rls/0024_edge_rate_limit_buckets.sql) is required. Refusing to boot.',
    );
  }
}

export interface EdgeGatewayOverrides {
  /** Inject a recording sink in proofs. Defaults to the redacting stdout logger. */
  readonly audit?: AuditLogger;
  /**
   * Inject a limiter in proofs. Defaults to the store the runtime requires
   * (Postgres in production, per-process in dev). The override exists so a
   * proof can demonstrate, on the REAL boot path, that a production boot
   * handed the memory limiter is REFUSED by assertRateLimitStoreAllowed
   * below — before a single request is served — rather than silently
   * permitting N-replicas-times-every-rate.
   */
  readonly limiter?: RateLimiter;
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
  // THE STORE IS SHARED IN PRODUCTION. The per-process limiter remains the
  // dev/selfcheck implementation; a production boot with it is refused below
  // rather than silently permitted (see assertRateLimitStoreAllowed).
  const limiter =
    overrides.limiter ??
    (config.runtime.isProduction
      ? new PgRateLimiter({ hmacKey: hmacKey })
      : new InMemoryRateLimiter(() => now().getTime()));
  assertRateLimitStoreAllowed(config.runtime.isProduction, limiter.store);
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
