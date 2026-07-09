// ══════════════════════════════════════════════════════════════════
// scheduling-service — Configuration
//
// Loads runtime, the database, and the PII encryption key — needed to decrypt
// the applicant's home district (an encrypted PII column) so a venue can be
// resolved. No G2G endpoints: venue assignment is a pure DB lookup against
// seeded reference data. Mirrors eligibility-service's DB+PII config shape.
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

export interface SchedulingSecurityConfig {
  /** pgcrypto symmetric key used to decrypt the home-district PII column. */
  readonly encryptionKey: string;
}

export interface SchedulingServiceConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
  readonly security: SchedulingSecurityConfig;
}

export function loadSchedulingConfig(source: EnvSource = process.env): SchedulingServiceConfig {
  const env = loadEnv({ PII_ENCRYPTION_KEY: string({ minLength: 32, secret: true }) }, source);
  return {
    runtime: loadRuntimeConfig('scheduling-service', source),
    database: loadDatabaseConfig(source),
    security: { encryptionKey: env.PII_ENCRYPTION_KEY },
  };
}
