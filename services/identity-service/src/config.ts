// ══════════════════════════════════════════════════════════════════
// identity-service — Configuration
//
// Composes the shared-config sections this service actually needs. It
// loads ONLY the NIDA G2G endpoint (not NESA/HEC/RIB) so the service does
// not demand secrets for agencies it never calls. Variable names follow
// the shared-config canon (NIDA_BASE_URL, NIDA_HMAC_SECRET) — see the
// .env reconciliation note in the slice docs.
// ══════════════════════════════════════════════════════════════════

import {
  integer,
  loadAuthVerifyConfig,
  loadDatabaseConfig,
  loadEnv,
  loadRuntimeConfig,
  loadSecurityConfig,
  string,
  url,
  withDefault,
  type AuthVerifyConfig,
  type DatabaseConfig,
  type EnvSource,
  type G2GEndpointConfig,
  type RuntimeConfig,
  type SecurityConfig,
} from '@usrp/shared-config';

export interface IdentityServiceConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
  readonly security: SecurityConfig;
  readonly nida: G2GEndpointConfig;
  /** Ingress auth: verify inbound bearer tokens (front door is service-internal). */
  readonly auth: AuthVerifyConfig;
}

/** Load just the NIDA endpoint config (base URL, HMAC secret, timeout). */
export function loadNidaConfig(source: EnvSource = process.env): G2GEndpointConfig {
  const env = loadEnv(
    {
      NIDA_BASE_URL: url({ protocols: ['http', 'https'] }),
      NIDA_HMAC_SECRET: string({ minLength: 8, secret: true }),
      NIDA_REQUEST_TIMEOUT_MS: withDefault(integer({ min: 500, max: 60_000 }), 5_000),
    },
    source,
  );
  return {
    baseUrl: env.NIDA_BASE_URL,
    hmacSecret: env.NIDA_HMAC_SECRET,
    timeoutMs: env.NIDA_REQUEST_TIMEOUT_MS,
  };
}

export function loadIdentityConfig(source: EnvSource = process.env): IdentityServiceConfig {
  return {
    runtime: loadRuntimeConfig('identity-service', source),
    database: loadDatabaseConfig(source),
    security: loadSecurityConfig(source),
    nida: loadNidaConfig(source),
    auth: loadAuthVerifyConfig(source),
  };
}
