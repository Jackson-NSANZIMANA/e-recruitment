// ══════════════════════════════════════════════════════════════════
// edge-gateway — Configuration
//
// Composed from @usrp/shared-config sections that already existed with no
// caller: loadCorsConfig and loadEdgeSessionConfig were written for this tier
// and have been dead code since 2026-07. This is the process that reads them.
//
// WHY loadAuthVerifyConfig IS HERE, AND WHAT IT IS NOT FOR.
//
// The edge verifies the officer token exactly ONCE — at login, on the token
// iam-service just handed it — for one reason: it must know the agency and
// roles to describe the session to the browser, and `GET /edge/v1/session`
// cannot invent them. Verifying is strictly better than base64-decoding: a
// misconfigured issuer or a clock skew fails at login, loudly, instead of
// surfacing as an unexplained 401 from a sibling service later.
//
// It is NOT a second authorization decision point. No REQUEST is authorized by
// reading claims: the session row is the authority for the browser boundary and
// PostgreSQL RLS is the authority for the data. Nothing below re-derives agency
// from a token on a per-request path.
//
// WHAT IS DELIBERATELY ABSENT:
//
//   • AGENCY. loadAgencyDeploymentConfig is NOT called. Agency comes from the
//     verified session per request (ADR-021 §2.1); a deployment-scoped agency
//     makes it a property of the process, and a process is something an
//     operator can point at the wrong agency.
//   • KAFKA. The edge publishes no domain events — see the reasoning in
//     src/observability/audit-log.ts. A broker outage must not be able to take
//     down login for every officer in the country.
//   • A NEW SECRET for credential encryption. The at-rest key is DERIVED from
//     EDGE_SESSION_HMAC_KEY under domain separation
//     (src/security/credential-cipher.ts). A new dev secret in .env.example
//     that assertProductionSecrets() does not fingerprint is a published key
//     that boots in production.
//   • CLIENT CREDENTIALS. Every upstream the edge calls is reachable with a
//     credential the human already presented, so there is no EDGE_CLIENT_ID /
//     EDGE_CLIENT_SECRET anywhere in this service and no machine identity to
//     steal from it.
// ══════════════════════════════════════════════════════════════════

import {
  deepFreeze,
  integer,
  loadAuthVerifyConfig,
  loadCorsConfig,
  loadDatabaseConfig,
  loadEdgeSessionConfig,
  loadEnv,
  loadRuntimeConfig,
  url,
  withDefault,
  type AuthVerifyConfig,
  type CorsConfig,
  type DatabaseConfig,
  type EdgeSessionConfig,
  type EnvSource,
  type RuntimeConfig,
} from '@usrp/shared-config';

export const EDGE_SERVICE_NAME = 'edge-gateway';

/** Every upstream this tier may reach. There is no dynamic target. */
export interface EdgeUpstreamConfig {
  readonly iamBaseUrl: string;
  readonly identityBaseUrl: string;
  readonly applicationBaseUrl: string;
  readonly fieldSyncBaseUrl: string;
  /** Per-call upstream deadline. A browser request cannot outlive this. */
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
 * requirement, not hardening: a 202 whose body reveals nothing still becomes an
 * identity-enumeration oracle by volume and timing without them.
 */
export interface EdgeRateLimitConfig {
  readonly loginPerMinute: number;
  readonly otpPerMinute: number;
  readonly verifyIdentityPerMinute: number;
  /**
   * How many `x-forwarded-for` hops this deployment's own ingress appends.
   *
   * 0 (the dev default) means "trust nothing": every caller shares ONE bucket,
   * which is the STRICTEST behaviour available, not the weakest. A spoofable
   * per-client key would be worse than a global cap.
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
  /** Used ONCE, at login, to read the agency/roles off the token being stored. */
  readonly auth: AuthVerifyConfig;
}

export function loadEdgeGatewayConfig(source: EnvSource = process.env): EdgeGatewayConfig {
  return {
    runtime: loadRuntimeConfig(EDGE_SERVICE_NAME, source),
    database: loadDatabaseConfig(source),
    session: loadEdgeSessionConfig(source),
    cors: loadCorsConfig(source),
    upstream: loadEdgeUpstreamConfig(source),
    rateLimits: loadEdgeRateLimitConfig(source),
    auth: loadAuthVerifyConfig(source),
  };
}
