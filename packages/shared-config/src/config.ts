// ══════════════════════════════════════════════════════════════════
// @usrp/shared-config — USRP configuration sections
//
// Each loader validates only the variables it owns and returns a typed,
// frozen section. Services compose the sections they need. Cross-cutting
// infra (db/kafka) is standardised here so every service reads the same
// variable names — the exact names Turbo already passes through
// (see turbo.json `env`) and docker-compose defines.
// ══════════════════════════════════════════════════════════════════

import { createPrivateKey, createPublicKey } from 'node:crypto';
import {
  EnvValidationError,
  boolean,
  deepFreeze,
  integer,
  list,
  loadEnv,
  oneOf,
  optional,
  port,
  string,
  url,
  withDefault,
  type EnvSource,
} from './env.js';

// ── Runtime ─────────────────────────────────────────────────

export const NODE_ENVS = ['development', 'test', 'staging', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Last-resort port when neither the specific nor the generic variable is set. */
const FALLBACK_PORT = 3000;

/**
 * The per-service port variable name, DERIVED from the service name:
 *
 *   'identity-service'  → 'PORT_IDENTITY_SERVICE'
 *   'agency-bff'        → 'PORT_AGENCY_BFF'
 *
 * A mechanical rule rather than a lookup table, because a lookup table is a
 * second source of truth and this one already drifted: .env.example carried
 * PORT_ROUTING_SERVICE for a service that does not exist, carried no variable
 * for application-service, and carried none at all for iam-service — the
 * token issuer. Rename a service and you rename its variable; nothing else
 * can silently disagree.
 */
export function portEnvVarFor(serviceName: string): string {
  return `PORT_${serviceName.toUpperCase().replace(/-/g, '_')}`;
}

export interface RuntimeConfig {
  readonly serviceName: string;
  readonly nodeEnv: NodeEnv;
  readonly isProduction: boolean;
  readonly port: number;
  readonly logLevel: LogLevel;
}

/**
 * Runtime section. The port resolves MOST-SPECIFIC-FIRST:
 *
 *   PORT_<SERVICE_NAME>  →  PORT  →  3000
 *
 * Before this, only the generic `PORT` was read and .env.example never set
 * it — so every PORT_* line in that file was decoration and all eleven
 * services defaulted to 3000 and fought over the socket. The specific
 * variable wins because it is the one that can express a whole topology in
 * a single shared .env, which is exactly how the dev stack is run.
 */
export function loadRuntimeConfig(serviceName: string, source: EnvSource = process.env): RuntimeConfig {
  const env = loadEnv(
    {
      NODE_ENV: withDefault(oneOf(NODE_ENVS), 'development'),
      PORT: withDefault(port(), FALLBACK_PORT),
      LOG_LEVEL: withDefault(oneOf(LOG_LEVELS), 'info'),
    },
    source,
  );

  // Validated with the same `port()` spec as the generic variable, so a typo
  // in PORT_IDENTITY_SERVICE fails loudly at boot instead of being ignored.
  const specificVar = portEnvVarFor(serviceName);
  const parsed = optional(port()).parse(specificVar, source[specificVar]);
  if (!parsed.ok) throw new EnvValidationError([parsed.error]);

  return deepFreeze({
    serviceName,
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: parsed.value ?? env.PORT,
    logLevel: env.LOG_LEVEL,
  });
}

// ── Database (PostgreSQL) ──────────────────────────────────────

export interface DatabaseConfig {
  readonly url: string;
  readonly maxConnections: number;
}

export function loadDatabaseConfig(source: EnvSource = process.env): DatabaseConfig {
  const env = loadEnv(
    {
      DATABASE_URL: url({ protocols: ['postgres', 'postgresql'] }),
      DATABASE_MAX_CONNECTIONS: withDefault(integer({ min: 1, max: 100 }), 20),
    },
    source,
  );
  return deepFreeze({ url: env.DATABASE_URL, maxConnections: env.DATABASE_MAX_CONNECTIONS });
}

// ── Redis ───────────────────────────────────────────────────
// Redis was removed from the stack on 2026-07-19 and REDIS_URL no longer
// exists in .env.example. This loader is kept for the day a real consumer
// appears (it is deliberately NOT part of loadServiceConfig — see below).

export interface RedisConfig {
  readonly url: string;
}

export function loadRedisConfig(source: EnvSource = process.env): RedisConfig {
  const env = loadEnv(
    { REDIS_URL: url({ protocols: ['redis', 'rediss'] }) },
    source,
  );
  return deepFreeze({ url: env.REDIS_URL });
}

// ── Kafka ───────────────────────────────────────────────────

export interface KafkaConfig {
  readonly brokers: readonly string[];
  readonly clientId: string;
  readonly ssl: boolean;
}

export function loadKafkaConfig(clientId: string, source: EnvSource = process.env): KafkaConfig {
  const env = loadEnv(
    {
      KAFKA_BROKERS: list({ minItems: 1 }),
      KAFKA_SSL: withDefault(boolean(), false),
    },
    source,
  );
  return deepFreeze({ brokers: env.KAFKA_BROKERS, clientId, ssl: env.KAFKA_SSL });
}

// ── G2G integrations (NIDA / NESA / HEC / RIB) ────────────────────
// HMAC secrets are dev-length in the mocks; production values are longer.

export interface G2GEndpointConfig {
  readonly baseUrl: string;
  readonly hmacSecret: string;
  readonly timeoutMs: number;
}

export interface G2GConfig {
  readonly nida: G2GEndpointConfig;
  readonly nesa: G2GEndpointConfig;
  readonly hec: G2GEndpointConfig;
  readonly rib: G2GEndpointConfig;
}

export function loadG2GConfig(source: EnvSource = process.env): G2GConfig {
  const env = loadEnv(
    {
      G2G_TIMEOUT_MS: withDefault(integer({ min: 500, max: 60_000 }), 5_000),

      NIDA_BASE_URL: url({ protocols: ['http', 'https'] }),
      NIDA_HMAC_SECRET: string({ minLength: 8, secret: true }),

      NESA_BASE_URL: url({ protocols: ['http', 'https'] }),
      NESA_HMAC_SECRET: string({ minLength: 8, secret: true }),

      HEC_BASE_URL: url({ protocols: ['http', 'https'] }),
      HEC_HMAC_SECRET: withDefault(string({ minLength: 8, secret: true }), 'dev_hec_hmac_secret'),

      RIB_BASE_URL: url({ protocols: ['http', 'https'] }),
      RIB_HMAC_SECRET: string({ minLength: 8, secret: true }),
    },
    source,
  );
  const timeoutMs = env.G2G_TIMEOUT_MS;
  return deepFreeze({
    nida: { baseUrl: env.NIDA_BASE_URL, hmacSecret: env.NIDA_HMAC_SECRET, timeoutMs },
    nesa: { baseUrl: env.NESA_BASE_URL, hmacSecret: env.NESA_HMAC_SECRET, timeoutMs },
    hec: { baseUrl: env.HEC_BASE_URL, hmacSecret: env.HEC_HMAC_SECRET, timeoutMs },
    rib: { baseUrl: env.RIB_BASE_URL, hmacSecret: env.RIB_HMAC_SECRET, timeoutMs },
  });
}

// ── Security ────────────────────────────────────────────────
// Master keys MUST be strong. We refuse to boot with weak keys — a bad
// key here means every hashed National ID and encrypted PII column is
// weak. 32 chars is the enforced floor for dev; production uses HSM/KMS.

export interface SecurityConfig {
  /** HMAC key used to derive the system-wide `nationalIdHash`. */
  readonly nationalIdHmacKey: string;
  /** pgcrypto symmetric key set as the `app.encryption_key` session var. */
  readonly encryptionKey: string;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
}

export function loadSecurityConfig(source: EnvSource = process.env): SecurityConfig {
  const env = loadEnv(
    {
      NATIONAL_ID_HMAC_KEY: string({ minLength: 32, secret: true }),
      PII_ENCRYPTION_KEY: string({ minLength: 32, secret: true }),
      JWT_ISSUER: withDefault(string(), 'usrp'),
      JWT_AUDIENCE: withDefault(string(), 'usrp-services'),
    },
    source,
  );
  return deepFreeze({
    nationalIdHmacKey: env.NATIONAL_ID_HMAC_KEY,
    encryptionKey: env.PII_ENCRYPTION_KEY,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
  });
}

// ── Auth verification (Ed25519 bearer tokens) ─────────────────────
// Every service that exposes HTTP verifies incoming bearer tokens with the
// issuer's PUBLIC key (asymmetric — the private signing key lives only with
// the token issuer, never shipped to verifiers). The public key is supplied
// base64-encoded (SPKI PEM) to dodge multiline-env pain, mirroring the QR
// signing key. JWT_ISSUER/JWT_AUDIENCE reuse the same names as SecurityConfig.

export interface AuthVerifyConfig {
  /** Issuer public key (SPKI PEM), decoded + validated at boot. */
  readonly authPublicKeyPem: string;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
}

export function loadAuthVerifyConfig(source: EnvSource = process.env): AuthVerifyConfig {
  const env = loadEnv(
    {
      // BASE64 of the SPKI PEM. Public key — NOT a secret. minLength guards
      // against an empty/truncated value.
      AUTH_JWT_PUBLIC_KEY_B64: string({ minLength: 40 }),
      JWT_ISSUER: withDefault(string(), 'usrp'),
      JWT_AUDIENCE: withDefault(string(), 'usrp-services'),
    },
    source,
  );

  const authPublicKeyPem = Buffer.from(env.AUTH_JWT_PUBLIC_KEY_B64, 'base64').toString('utf8');
  // Fails loud at boot if the value is not a valid public key.
  createPublicKey(authPublicKeyPem);

  return deepFreeze({
    authPublicKeyPem,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
  });
}

// ── Auth issuer (PRIVATE key) ─────────────────────────────────
// The mirror of loadAuthVerifyConfig for the ONE service that MINTS tokens
// (iam-service). It holds the Ed25519 PRIVATE key; every other service only
// ever verifies with the public key — the whole point of the asymmetric design.
// The private key is a SECRET, supplied base64-encoded (PKCS#8 PEM) to dodge
// multiline-env pain, and validated with createPrivateKey at boot so a bad key
// fails loud rather than at first login. JWT_ISSUER/JWT_AUDIENCE reuse the same
// names as AuthVerifyConfig so mint and verify agree by construction.
// Production: this key belongs in an HSM/KMS with rotation — a deferred residual.

export interface AuthIssuerConfig {
  /** Issuer private key (PKCS#8 PEM), decoded + validated at boot. SECRET. */
  readonly authPrivateKeyPem: string;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
}

export function loadAuthIssuerConfig(source: EnvSource = process.env): AuthIssuerConfig {
  const env = loadEnv(
    {
      // BASE64 of the PKCS#8 PEM. This is the signing SECRET.
      AUTH_JWT_PRIVATE_KEY_B64: string({ minLength: 40, secret: true }),
      JWT_ISSUER: withDefault(string(), 'usrp'),
      JWT_AUDIENCE: withDefault(string(), 'usrp-services'),
    },
    source,
  );

  const authPrivateKeyPem = Buffer.from(env.AUTH_JWT_PRIVATE_KEY_B64, 'base64').toString('utf8');
  // Fails loud at boot if the value is not a valid private key.
  createPrivateKey(authPrivateKeyPem);

  return deepFreeze({
    authPrivateKeyPem,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
  });
}

// ── CORS (edge tier only) ──────────────────────────────────────
// CORS_ORIGINS has existed in .env.example from the beginning with nothing
// reading it. It becomes load-bearing the moment a browser talks to a BFF,
// so it gets a real loader. Internal microservices must NOT call this: a
// service no browser reaches should emit no CORS headers at all.

export interface CorsConfig {
  /** Exact-match allow-list. Never a pattern — see shared-http/cors.ts. */
  readonly origins: readonly string[];
}

export function loadCorsConfig(source: EnvSource = process.env): CorsConfig {
  const env = loadEnv(
    {
      CORS_ORIGINS: withDefault(list({ minItems: 1 }), [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3002',
      ]),
    },
    source,
  );
  return deepFreeze({ origins: env.CORS_ORIGINS });
}

// ── Edge session (BFF cookie tier) ───────────────────────────────
// The browser holds an opaque HANDLE; the upstream credential (officer Ed25519
// JWT or citizen opaque session token) stays server-side in the edge session
// store. Two TTLs, not one:
//
//   idle     — sliding, refreshed on activity (30 min, matching ADR-018).
//   absolute — a hard ceiling no amount of activity extends, so a stolen
//              handle cannot be kept alive forever by the thief's own traffic.
//              A sliding TTL alone is an immortal session.
//
// EDGE_SESSION_HMAC_KEY keys the hash of the stored handle. A KEYED hash, not
// a bare digest: a leaked database dump is then not a set of replayable
// session handles, because the key lives in the process/HSM and not the table.
// Mirrors the NATIONAL_ID_HMAC_KEY posture exactly.

export interface EdgeSessionConfig {
  /** Keys the stored session-handle hash. SECRET. */
  readonly handleHmacKey: string;
  /** Sliding inactivity window, seconds. */
  readonly idleTtlSeconds: number;
  /** Hard ceiling on total session lifetime, seconds. */
  readonly absoluteTtlSeconds: number;
  /**
   * Emit cookies with `Secure`. MUST be true in production — and the
   * __Host- prefix requires it, so shared-http will refuse to serialize
   * the session cookie at all when this is false.
   */
  readonly secureCookies: boolean;
}

export function loadEdgeSessionConfig(source: EnvSource = process.env): EdgeSessionConfig {
  const env = loadEnv(
    {
      EDGE_SESSION_HMAC_KEY: string({ minLength: 32, secret: true }),
      EDGE_SESSION_IDLE_TTL_SECONDS: withDefault(integer({ min: 60, max: 86_400 }), 1_800),
      EDGE_SESSION_ABSOLUTE_TTL_SECONDS: withDefault(integer({ min: 300, max: 604_800 }), 43_200),
      EDGE_COOKIE_SECURE: withDefault(boolean(), true),
    },
    source,
  );

  // Cross-field: an absolute ceiling below the sliding window is a silent
  // contradiction that would expire sessions mid-activity for no stated reason.
  if (env.EDGE_SESSION_ABSOLUTE_TTL_SECONDS < env.EDGE_SESSION_IDLE_TTL_SECONDS) {
    throw new EnvValidationError([
      'EDGE_SESSION_ABSOLUTE_TTL_SECONDS must be >= EDGE_SESSION_IDLE_TTL_SECONDS ' +
        '(an absolute ceiling below the sliding window expires active sessions).',
    ]);
  }

  return deepFreeze({
    handleHmacKey: env.EDGE_SESSION_HMAC_KEY,
    idleTtlSeconds: env.EDGE_SESSION_IDLE_TTL_SECONDS,
    absoluteTtlSeconds: env.EDGE_SESSION_ABSOLUTE_TTL_SECONDS,
    secureCookies: env.EDGE_COOKIE_SECURE,
  });
}

// ── Agency deployment selector ──────────────────────────────────
// The whole mechanism behind "ONE agency-bff codebase, THREE deployments".
// Three codebases would be three places to forget the same security fix; the
// officer token already carries the agency claim and the DB roles do the real
// enforcement, so the deployment only needs to know which agency it fronts.

export const AGENCIES = ['RDF', 'RNP', 'RCS'] as const;
export type AgencyCode = (typeof AGENCIES)[number];

export interface AgencyDeploymentConfig {
  readonly agency: AgencyCode;
}

export function loadAgencyDeploymentConfig(source: EnvSource = process.env): AgencyDeploymentConfig {
  const env = loadEnv({ AGENCY: oneOf(AGENCIES) }, source);
  return deepFreeze({ agency: env.AGENCY });
}

// ── Composite service config ───────────────────────────────────

export interface ServiceConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
  readonly kafka: KafkaConfig;
}

/**
 * Standard bootstrap config for a typical USRP microservice
 * (runtime + database + kafka). Services layer on the extra sections they
 * need (e.g. G2G, security) explicitly.
 *
 * REDIS IS DELIBERATELY ABSENT. It used to be a required member, which meant
 * this function demanded REDIS_URL — a variable deleted from .env.example on
 * 2026-07-19 along with Redis itself. Any caller would have failed to boot on
 * a validation error no operator could satisfy.
 */
export function loadServiceConfig(serviceName: string, source: EnvSource = process.env): ServiceConfig {
  return deepFreeze({
    runtime: loadRuntimeConfig(serviceName, source),
    database: loadDatabaseConfig(source),
    kafka: loadKafkaConfig(serviceName, source),
  });
}
