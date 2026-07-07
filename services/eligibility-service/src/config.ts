// ══════════════════════════════════════════════════════════════════
// eligibility-service — Configuration
//
// Loads ONLY what this service uses: runtime, the database, and the PII
// encryption key (to decrypt the applicant's date of birth). It does not
// demand the NID HMAC key or any G2G secret — the age gate calls no
// external agency and never hashes a National ID.
// ══════════════════════════════════════════════════════════════════

import {
  loadDatabaseConfig,
  loadEnv,
  loadRuntimeConfig,
  string,
  type DatabaseConfig,
  type EnvSource,
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
}

export function loadEligibilityConfig(source: EnvSource = process.env): EligibilityServiceConfig {
  const env = loadEnv({ PII_ENCRYPTION_KEY: string({ minLength: 32, secret: true }) }, source);
  return {
    runtime: loadRuntimeConfig('eligibility-service', source),
    database: loadDatabaseConfig(source),
    security: { encryptionKey: env.PII_ENCRYPTION_KEY },
  };
}
