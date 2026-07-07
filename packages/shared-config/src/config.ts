// ══════════════════════════════════════════════════════════════════
// @usrp/shared-config — USRP configuration sections
//
// Each loader validates only the variables it owns and returns a typed,
// frozen section. Services compose the sections they need. Cross-cutting
// infra (db/redis/kafka) is standardised here so every service reads the
// same variable names — the exact names Turbo already passes through
// (see turbo.json `env`) and docker-compose defines.
// ══════════════════════════════════════════════════════════════════

import {
  boolean,
  deepFreeze,
  integer,
  list,
  loadEnv,
  oneOf,
  port,
  string,
  url,
  withDefault,
  type EnvSource,
} from './env.js';

// ── Runtime ───────────────────────────────────────────────────────

export const NODE_ENVS = ['development', 'test', 'staging', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface RuntimeConfig {
  readonly serviceName: string;
  readonly nodeEnv: NodeEnv;
  readonly isProduction: boolean;
  readonly port: number;
  readonly logLevel: LogLevel;
}

export function loadRuntimeConfig(serviceName: string, source: EnvSource = process.env): RuntimeConfig {
  const env = loadEnv(
    {
      NODE_ENV: withDefault(oneOf(NODE_ENVS), 'development'),
      PORT: withDefault(port(), 3000),
      LOG_LEVEL: withDefault(oneOf(LOG_LEVELS), 'info'),
    },
    source,
  );
  return deepFreeze({
    serviceName,
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
  });
}

// ── Database (PostgreSQL) ─────────────────────────────────────────

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

// ── Redis ─────────────────────────────────────────────────────────

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

// ── Kafka ─────────────────────────────────────────────────────────

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

// ── Security ──────────────────────────────────────────────────────
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

// ── Composite service config ──────────────────────────────────────

export interface ServiceConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
  readonly redis: RedisConfig;
  readonly kafka: KafkaConfig;
}

/**
 * Standard bootstrap config for a typical USRP microservice
 * (runtime + database + redis + kafka). Services layer on the extra
 * sections they need (e.g. G2G, security) explicitly.
 */
export function loadServiceConfig(serviceName: string, source: EnvSource = process.env): ServiceConfig {
  return deepFreeze({
    runtime: loadRuntimeConfig(serviceName, source),
    database: loadDatabaseConfig(source),
    redis: loadRedisConfig(source),
    kafka: loadKafkaConfig(serviceName, source),
  });
}
