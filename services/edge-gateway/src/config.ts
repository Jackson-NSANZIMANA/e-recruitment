// ══════════════════════════════════════════════════════════════════
// edge-gateway — Configuration
//
// The edge is the ONLY browser-facing process, so it is the only one that
// loads the two browser-shaped sections (`loadCorsConfig`,
// `loadEdgeSessionConfig`) — both have existed in @usrp/shared-config with no
// consumer since the tier was decided but not built.
//
// WHAT IT DELIBERATELY DOES NOT LOAD:
//   • NATIONAL_ID_HMAC_KEY / PII_ENCRYPTION_KEY. The edge resolves no
//     identity and decrypts no PII — it forwards a raw National ID over TLS
//     to identity-service and forgets it. Holding the applicant key here
//     would make the highest-value target in the platform (ADR-021 §3) also
//     the holder of the crown jewels.
//   • AUTH_JWT_PRIVATE_KEY_B64. The edge MINTS nothing. It verifies the
//     officer token it receives from iam-service with the PUBLIC key
//     (loadAuthVerifyConfig) purely to read the agency/roles claims it must
//     put in the session — the mint side stays in iam-service alone.
//
// It DOES load the database: the edge session store is a Postgres table, so
// a restart, a second replica and a `DELETE` for revocation all behave.
// ══════════════════════════════════════════════════════════════════

import {
  integer,
  loadAuthVerifyConfig,
  loadCorsConfig,
  loadDatabaseConfig,
  loadEdgeSessionConfig,
  loadEnv,
  loadRuntimeConfig,
  string,
  url,
  withDefault,
  type AuthVerifyConfig,
  type CorsConfig,
  type DatabaseConfig,
  type EdgeSessionConfig,
  type EnvSource,
  type RuntimeConfig,
} from '@usrp/shared-config';

/** The service name — also fixes the port variable to PORT_EDGE_GATEWAY. */
export const EDGE_SERVICE_NAME = 'edge-gateway';

/**
 * The three upstreams the edge fronts. Names follow the shared-config canon
 * (`IAM_BASE_URL` and `APPLICATION_SERVICE_BASE_URL` already exist and are
 * already read by identity-service; `IDENTITY_SERVICE_BASE_URL` is new here).
 */
export interface UpstreamConfig {
  readonly iamBaseUrl: string;
  readonly identityBaseUrl: string;
  readonly applicationBaseUrl: string;
  readonly timeoutMs: number;
}

/**
 * Rate limits. On the OTP and identity operations these are a CORRECTNESS
 * requirement, not hardening: a 202 that reveals nothing about its subject
 * still becomes an enumeration oracle by volume (ADR-021 §2.7 item 4).
 */
export interface RateLimitConfig {
  /** Requests per window from one client address, per operation. */
  readonly perClient: number;
  /** Requests per window for one SUBJECT (a National ID / login handle). */
  readonly perSubject: number;
  /** Window length in seconds. */
  readonly windowSeconds: number;
  /**
   * Header naming the client address, set by the trusted reverse proxy
   * (Kong). The RIGHTMOST value is used: a proxy APPENDS the peer it saw, so
   * the last hop is the only entry a client cannot forge by sending its own
   * header. Leftmost — the usual choice — is attacker-controlled.
   */
  readonly clientIpHeader: string;
}

export interface EdgeGatewayConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
  readonly session: EdgeSessionConfig;
  readonly cors: CorsConfig;
  /** Public key + issuer/audience used to READ the officer token's claims. */
  readonly auth: AuthVerifyConfig;
  readonly upstream: UpstreamConfig;
  readonly rateLimit: RateLimitConfig;
}

export function loadUpstreamConfig(source: EnvSource = process.env): UpstreamConfig {
  const env = loadEnv(
    {
      IAM_BASE_URL: url({ protocols: ['http', 'https'] }),
      IDENTITY_SERVICE_BASE_URL: url({ protocols: ['http', 'https'] }),
      APPLICATION_SERVICE_BASE_URL: url({ protocols: ['http', 'https'] }),
      EDGE_UPSTREAM_TIMEOUT_MS: withDefault(integer({ min: 500, max: 60_000 }), 5_000),
    },
    source,
  );
  return {
    iamBaseUrl: env.IAM_BASE_URL,
    identityBaseUrl: env.IDENTITY_SERVICE_BASE_URL,
    applicationBaseUrl: env.APPLICATION_SERVICE_BASE_URL,
    timeoutMs: env.EDGE_UPSTREAM_TIMEOUT_MS,
  };
}

export function loadRateLimitConfig(source: EnvSource = process.env): RateLimitConfig {
  const env = loadEnv(
    {
      EDGE_RATE_LIMIT_PER_CLIENT: withDefault(integer({ min: 1, max: 10_000 }), 30),
      EDGE_RATE_LIMIT_PER_SUBJECT: withDefault(integer({ min: 1, max: 10_000 }), 5),
      EDGE_RATE_LIMIT_WINDOW_SECONDS: withDefault(integer({ min: 1, max: 3_600 }), 300),
      EDGE_CLIENT_IP_HEADER: withDefault(string({ minLength: 1 }), 'x-forwarded-for'),
    },
    source,
  );
  return {
    perClient: env.EDGE_RATE_LIMIT_PER_CLIENT,
    perSubject: env.EDGE_RATE_LIMIT_PER_SUBJECT,
    windowSeconds: env.EDGE_RATE_LIMIT_WINDOW_SECONDS,
    clientIpHeader: env.EDGE_CLIENT_IP_HEADER.toLowerCase(),
  };
}

export function loadEdgeGatewayConfig(source: EnvSource = process.env): EdgeGatewayConfig {
  return {
    runtime: loadRuntimeConfig(EDGE_SERVICE_NAME, source),
    database: loadDatabaseConfig(source),
    session: loadEdgeSessionConfig(source),
    cors: loadCorsConfig(source),
    auth: loadAuthVerifyConfig(source),
    upstream: loadUpstreamConfig(source),
    rateLimit: loadRateLimitConfig(source),
  };
}
