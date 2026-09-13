// ══════════════════════════════════════════════════════════════════
// @usrp/edge-gateway — Public API & composition root
//
// Assembles the edge from a config plus its four seams: the session store and
// the three upstream gateways. Every seam is injectable, which is what lets the
// selfcheck drive the edge's OWN behaviour — cookies, CSRF, session mapping,
// credential isolation, the bare 404 — against stub upstreams, without standing
// up iam, identity and application first.
//
// Transport (the HTTP server, CORS, readiness) is composed in main.ts, not here,
// following the identity-service template.
// ══════════════════════════════════════════════════════════════════

import type { Route } from '@usrp/shared-http';
import { EdgeSessionService } from './application/session.service.js';
import type { EdgeSessionStore } from './ports/session-store.js';
import type { ApplicationGateway, IamGateway, IdentityGateway } from './ports/upstream.js';
import { PgEdgeSessionStore } from './adapters/store/session-store.pg.js';
import { HttpApplicationGateway } from './adapters/upstream/application.http-gateway.js';
import { HttpIamGateway } from './adapters/upstream/iam.http-gateway.js';
import { HttpIdentityGateway } from './adapters/upstream/identity.http-gateway.js';
import { UpstreamClient } from './adapters/upstream/http-json.js';
import { RateLimiter } from './adapters/http/rate-limit.js';
import type { EdgeDeps } from './adapters/http/deps.js';
import { sessionRoutes } from './adapters/http/session.controller.js';
import { officerAuthRoutes } from './adapters/http/auth-officer.controller.js';
import { applicantAuthRoutes } from './adapters/http/auth-applicant.controller.js';
import { officerReadRoutes } from './adapters/http/officer-reads.controller.js';
import { officerTransitionRoutes } from './adapters/http/officer-transitions.controller.js';
import { walkInRoutes } from './adapters/http/walk-in.controller.js';
import { identityRoutes } from './adapters/http/identity.controller.js';
import { citizenRoutes } from './adapters/http/citizen.controller.js';
import type { EdgeGatewayConfig } from './config.js';

/** Overrides for proofs. Production passes none. */
export interface EdgeGatewayOverrides {
  readonly store?: EdgeSessionStore;
  readonly iam?: IamGateway;
  readonly identity?: IdentityGateway;
  readonly applications?: ApplicationGateway;
  readonly now?: () => Date;
}

export interface EdgeGateway {
  readonly routes: readonly Route[];
  readonly deps: EdgeDeps;
  /** Backs GET /ready. False when the session store cannot serve. */
  ready(): Promise<boolean>;
  /** Drop expired rate-limit windows. Called on a timer by main.ts. */
  sweep(): void;
}

export function createEdgeGateway(
  config: EdgeGatewayConfig,
  overrides: EdgeGatewayOverrides = {},
): EdgeGateway {
  const client = new UpstreamClient({ timeoutMs: config.upstream.timeoutMs });

  const store =
    overrides.store ??
    new PgEdgeSessionStore({
      handleHmacKey: config.session.handleHmacKey,
      // The stored-handle key ALSO encrypts the credential at rest. One key,
      // one rotation, one thing to put in the HSM — and rotating it invalidates
      // every live session, which is the correct blast radius for a key whose
      // compromise means every held credential is readable.
      credentialKey: config.session.handleHmacKey,
      idleTtlSeconds: config.session.idleTtlSeconds,
    });

  const sessions = new EdgeSessionService(store, {
    idleTtlSeconds: config.session.idleTtlSeconds,
    absoluteTtlSeconds: config.session.absoluteTtlSeconds,
    authPublicKeyPem: config.auth.authPublicKeyPem,
    jwtIssuer: config.auth.jwtIssuer,
    jwtAudience: config.auth.jwtAudience,
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  });

  const limiter = new RateLimiter({
    perClient: config.rateLimit.perClient,
    perSubject: config.rateLimit.perSubject,
    windowSeconds: config.rateLimit.windowSeconds,
    subjectHmacKey: config.session.handleHmacKey,
    clientIpHeader: config.rateLimit.clientIpHeader,
  });

  const deps: EdgeDeps = {
    sessions,
    iam: overrides.iam ?? new HttpIamGateway(client, config.upstream.iamBaseUrl),
    identity:
      overrides.identity ?? new HttpIdentityGateway(client, config.upstream.identityBaseUrl),
    applications:
      overrides.applications ??
      new HttpApplicationGateway(client, config.upstream.applicationBaseUrl),
    limiter,
    secureCookies: config.session.secureCookies,
    preSessionTtlSeconds: config.session.idleTtlSeconds,
  };

  return {
    routes: [
      ...sessionRoutes(deps),
      ...officerAuthRoutes(deps),
      ...applicantAuthRoutes(deps),
      ...officerReadRoutes(deps),
      ...officerTransitionRoutes(deps),
      ...walkInRoutes(deps),
      ...identityRoutes(deps),
      ...citizenRoutes(deps),
    ],
    deps,
    ready: (): Promise<boolean> => store.healthy(),
    sweep: (): void => {
      limiter.sweep();
    },
  };
}

// ── Re-exports ───────────────────────────────────────────────────────
export {
  EDGE_PATHS,
  EDGE_PREFIX,
  BROKERED_OPERATIONS,
  PUBLIC_OPERATIONS,
} from './adapters/http/paths.js';
export { cookieNames, clearedCookies, csrfCookie, sessionCookie } from './adapters/http/cookies.js';
export { CSRF_HEADER, constantTimeEquals, csrfAccepted, isUnsafe } from './adapters/http/csrf.js';
export { RateLimiter } from './adapters/http/rate-limit.js';
export type { EdgeDeps } from './adapters/http/deps.js';
export { EdgeSessionService } from './application/session.service.js';
export type { EdgeSessionServiceOptions, IssuedSession } from './application/session.service.js';
export { PgEdgeSessionStore } from './adapters/store/session-store.pg.js';
export { InMemoryEdgeSessionStore } from './adapters/store/session-store.memory.js';
export { hashHandle, mintCsrfToken, mintHandle } from './domain/handle.js';
export { UpstreamClient } from './adapters/upstream/http-json.js';
export { HttpIamGateway } from './adapters/upstream/iam.http-gateway.js';
export { HttpIdentityGateway } from './adapters/upstream/identity.http-gateway.js';
export { HttpApplicationGateway } from './adapters/upstream/application.http-gateway.js';
export { toTransitionOutcome } from './adapters/upstream/transition-outcome.js';
export { projectSession } from './domain/session.js';
export type {
  EdgeSession,
  SessionEndedReason,
  SessionKind,
  SessionView,
} from './domain/session.js';
export { SessionStoreError, UpstreamCredentialRejected, UpstreamError } from './domain/errors.js';
export type { EdgeSessionStore, SessionLookup } from './ports/session-store.js';
export type {
  AmberQueueRow,
  ApplicationGateway,
  ApplicationListRow,
  CredentialOutcome,
  ErasureRequestOutcome,
  IamGateway,
  IdentityGateway,
  IdentityVerifyOutcome,
  MedicalVerdict,
  MyApplicationRow,
  StatusHistoryRow,
  TransitionOutcome,
  UpstreamContext,
  WalkInRegisterOutcome,
  WalkInRegistration,
} from './ports/upstream.js';
export {
  EDGE_SERVICE_NAME,
  loadEdgeGatewayConfig,
  loadRateLimitConfig,
  loadUpstreamConfig,
} from './config.js';
export type { EdgeGatewayConfig, RateLimitConfig, UpstreamConfig } from './config.js';
