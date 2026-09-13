// ══════════════════════════════════════════════════════════════════
// edge-gateway — Configuration
//
// Composed from @usrp/shared-config sections that already existed and had no
// caller: loadCorsConfig and loadEdgeSessionConfig were written for this tier
// and have been dead code since 2026-07. This is the process that reads them.
//
// WHAT IS DELIBERATELY ABSENT:
//
//   • AGENCY. loadAgencyDeploymentConfig is NOT called. Agency is derived from
//     the verified officer session on every request (ADR-021 §2.1); a
//     deployment-scoped agency would make it a property of the process, and a
//     process is something an operator can misconfigure. One deployment serves
//     all three agencies and cannot be pointed at the wrong one.
//
//   • loadAuthIssuerConfig / loadAuthVerifyConfig. The edge does not mint or
//     verify Ed25519 tokens. It holds an officer's token opaquely and forwards
//     it upstream; interpreting its claims here would create a second
//     authorization decision point that could disagree with the first. The
//     agency and roles stored on the session come from iam-service's login
//     response path, and PostgreSQL RLS remains the real boundary.
//
//   • KAFKA. The edge publishes no domain events — see the audit note in
//     src/observability/audit-log.ts. Nothing here should be able to make the
//     browser boundary unavailable because a broker is down.
//
//   • A NEW SECRET for credential encryption. The at-rest key for stored
//     upstream credentials is DERIVED from EDGE_SESSION_HMAC_KEY with domain
//     separation (src/security/credential-cipher.ts) rather than read from a
//     new variable. A new secret in .env.example that assertProductionSecrets()
//     does not fingerprint is a published key that boots in production.
// ══════════════════════════════════════════════════════════════════

import {
  deepFreeze,
  integer,
  loadCorsConfig,
  loadDatabaseConfig,
  loadEdgeSessionConfig,
  loadEnv,
  loadRuntimeConfig,
  url,
  withDefault,
  type CorsConfig,
  type DatabaseConfig,
  type EdgeSessionConfig,
  type EnvSource,
  type RuntimeConfig,
} from '@usrp/shared-config';

export const EDGE_SERVICE_NAME = 'edge-gateway';

/** Every upstream this tier is allowed to reach. There is no dynamic target. */
export interface EdgeUpstreamConfig {
  readonly iamBaseUrl: string;
  readonly identityBaseUrl: string;
  readonly applicationBaseUrl: string;
  readonly fieldSyncBaseUrl: string;
  /** Per-request upstream deadline. A browser request cannot outlive this. */
  readonly timeoutMs: number;
  /** Hard ceiling on an upstream response body the edge will buffer. */
  readonly maxResponseBytes: number;
}

export function loadEdgeUpstreamConfig(source: EnvSource = process.env): EdgeUpstreamConfig {
  const env = loadEnv(
    {
      IAM_BASE_URL: url({ protocols: ['http', 'https'] }),
      IDENTITY_SERVICE_BASE_URL: url({ protocols: ['http', 'https'] }),
      APPLICATION_SERVICE_BASE_URL: url({ protocols: ['http', 'https'] }),
      FIELD_SYNC_SERVICE_BASE_URL: url({ protocols: ['http', 'https'] }),
      EDGE_UPSTREAM_TIMEOUT_MS: withDefault(integer({ min: 500, max: 60_000 }), 8_000),
      EDGE_UPSTREAM_MAX_RESPONSE_BYTES: withDefault(
        integer({ min: 1_024, max: 8 * 1_024 * 1_024 }),
        1_024 * 1_024,
      ),
    },
    source,
  );
  return deepFreeze({
    iamBaseUrl: env.IAM_BASE_URL,
    identityBaseUrl: env.IDENTITY_SERVICE_BASE_URL,
    applicationBaseUrl: env.APPLICATION_SERVICE_BASE_URL,
    fieldSyncBaseUrl: env.FIELD_SYNC_SERVICE_BASE_URL,
    timeoutMs: env.EDGE_UPSTREAM_TIMEOUT_MS,
    maxResponseBytes: env.EDGE_UPSTREAM_MAX_RESPONSE_BYTES,
  });
}

/**
 * Rate limits. On officer login and applicant OTP these are a CORRECTNESS
 * requirement, not hardening: a 202 that reveals nothing in its body still
 * becomes an identity-enumeration oracle by volume and timing without them.
 */
export interface EdgeRateLimitConfig {
  readonly loginPerMinute: number;
  readonly otpPerMinute: number;
  readonly verifyIdentityPerMinute: number;
  /**
   * How many `x-forwarded-for` hops the deployment's own ingress appends.
   *
   * 0 (the dev default) means "trust nothing": every caller lands in ONE
   * shared bucket, which is the STRICTEST behaviour, not the weakest. A
   * spoofable per-client key would be worse than a global cap. Production sets
   * this to the real hop count so the ingress-written client address is used.
   */
  readonly trustedProxyHops: number;
}

export function loadEdgeRateLimitConfig(source: EnvSource = process.env): EdgeRateLimitConfig {
  const env = loadEnv(
    {
      EDGE_LOGIN_RATE_LIMIT_PER_MINUTE: withDefault(integer({ min: 1, max: 10_000 }), 10),
      EDGE_OTP_RATE_LIMIT_PER_MINUTE: withDefault(integer({ min: 1, max: 10_000 }), 5),
      EDGE_VERIFY_IDENTITY_RATE_LIMIT_PER_MINUTE: withDefault(integer({ min: 1, max: 10_000 }), 20),
      EDGE_TRUSTED_PROXY_HOPS: withDefault(integer({ min: 0, max: 8 }), 0),
    },
    source,
  );
  return deepFreeze({
    loginPerMinute: env.EDGE_LOGIN_RATE_LIMIT_PER_MINUTE,
    otpPerMinute: env.EDGE_OTP_RATE_LIMIT_PER_MINUTE,
    verifyIdentityPerMinute: env.EDGE_VERIFY_IDENTITY_RATE_LIMIT_PER_MINUTE,
    trustedProxyHops: env.EDGE_TRUSTED_PROXY_HOPS,
  });
}

export interface EdgeGatewayConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
  readonly session: EdgeSessionConfig;
  readonly cors: CorsConfig;
  readonly upstream: EdgeUpstreamConfig;
  readonly rateLimits: EdgeRateLimitConfig;
}

export function loadEdgeGatewayConfig(source: EnvSource = process.env): EdgeGatewayConfig {
  return {
    runtime: loadRuntimeConfig(EDGE_SERVICE_NAME, source),
    database: loadDatabaseConfig(source),
    session: loadEdgeSessionConfig(source),
    cors: loadCorsConfig(source),
    upstream: loadEdgeUpstreamConfig(source),
    rateLimits: loadEdgeRateLimitConfig(source),
  };
}
