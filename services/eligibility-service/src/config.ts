// ══════════════════════════════════════════════════════════════════
// eligibility-service — Configuration
//
// Loads runtime, the database, the PII encryption key (to decrypt the
// applicant's date of birth for the age gate), and the NESA G2G endpoint
// (for the A-Level gate) plus the HEC G2G endpoint (for the degree gate).
// Variable names follow the shared-config canon (NESA_BASE_URL,
// NESA_HMAC_SECRET, HEC_BASE_URL, HEC_HMAC_SECRET) and mirror
// identity-service's loadNidaConfig — see the .env reconciliation note in
// the slice docs.
// ══════════════════════════════════════════════════════════════════

import {
  integer,
  loadDatabaseConfig,
  loadEnv,
  loadRuntimeConfig,
  string,
  url,
  withDefault,
  type DatabaseConfig,
  type EnvSource,
  type G2GEndpointConfig,
  type RuntimeConfig,
} from '@usrp/shared-config';

export interface EligibilitySecurityConfig {
  /** pgcrypto symmetric key used to decrypt PII columns. */
  readonly encryptionKey: string;
}

export interface EligibilityServiceConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
  readonly security: EligibilitySecurityConfig;
  readonly nesa: G2GEndpointConfig;
  readonly hec: G2GEndpointConfig;
}

/** Load just the NESA endpoint config (base URL, HMAC secret, timeout). */
export function loadNesaConfig(source: EnvSource = process.env): G2GEndpointConfig {
  const env = loadEnv(
    {
      NESA_BASE_URL: url({ protocols: ['http', 'https'] }),
      NESA_HMAC_SECRET: string({ minLength: 8, secret: true }),
      NESA_REQUEST_TIMEOUT_MS: withDefault(integer({ min: 500, max: 60_000 }), 5_000),
    },
    source,
  );
  return {
    baseUrl: env.NESA_BASE_URL,
    hmacSecret: env.NESA_HMAC_SECRET,
    timeoutMs: env.NESA_REQUEST_TIMEOUT_MS,
  };
}

/** Load just the HEC endpoint config (base URL, HMAC secret, timeout). */
export function loadHecConfig(source: EnvSource = process.env): G2GEndpointConfig {
  const env = loadEnv(
    {
      HEC_BASE_URL: url({ protocols: ['http', 'https'] }),
      HEC_HMAC_SECRET: string({ minLength: 8, secret: true }),
      HEC_REQUEST_TIMEOUT_MS: withDefault(integer({ min: 500, max: 60_000 }), 5_000),
    },
    source,
  );
  return {
    baseUrl: env.HEC_BASE_URL,
    hmacSecret: env.HEC_HMAC_SECRET,
    timeoutMs: env.HEC_REQUEST_TIMEOUT_MS,
  };
}

export function loadEligibilityConfig(source: EnvSource = process.env): EligibilityServiceConfig {
  const env = loadEnv({ PII_ENCRYPTION_KEY: string({ minLength: 32, secret: true }) }, source);
  return {
    runtime: loadRuntimeConfig('eligibility-service', source),
    database: loadDatabaseConfig(source),
    security: { encryptionKey: env.PII_ENCRYPTION_KEY },
    nesa: loadNesaConfig(source),
    hec: loadHecConfig(source),
  };
}
