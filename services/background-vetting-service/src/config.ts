// ══════════════════════════════════════════════════════════════════
// background-vetting-service — Configuration
//
// Among the leanest configs in the platform. This gate reads NO database
// (it keys off the nationalIdHash carried in APPLICANT_SUBMITTED) and
// decrypts NO PII (no encryption key). It needs exactly: runtime (service
// name, port for health/readiness) and the RIB G2G endpoint. Demanding
// nothing more keeps its blast radius minimal.
//
// Variable names follow the shared-config canon (RIB_BASE_URL,
// RIB_HMAC_SECRET, RIB_REQUEST_TIMEOUT_MS), mirroring loadNesaConfig /
// loadHecConfig. NOTE: .env.example currently uses the divergent
// RIB_API_BASE_URL / RIB_REQUEST_TIMEOUT_MS naming — the code canon here is
// the source of truth; the .env reconciliation is a tracked housekeeping item
// (see the slice doc).
// ══════════════════════════════════════════════════════════════════

import {
  integer,
  loadEnv,
  loadRuntimeConfig,
  string,
  url,
  withDefault,
  type EnvSource,
  type G2GEndpointConfig,
  type RuntimeConfig,
} from '@usrp/shared-config';

export interface BackgroundVettingServiceConfig {
  readonly runtime: RuntimeConfig;
  readonly rib: G2GEndpointConfig;
}

/** Load just the RIB endpoint config (base URL, HMAC secret, timeout). */
export function loadRibConfig(source: EnvSource = process.env): G2GEndpointConfig {
  const env = loadEnv(
    {
      RIB_BASE_URL: url({ protocols: ['http', 'https'] }),
      RIB_HMAC_SECRET: string({ minLength: 8, secret: true }),
      RIB_REQUEST_TIMEOUT_MS: withDefault(integer({ min: 500, max: 60_000 }), 5_000),
    },
    source,
  );
  return {
    baseUrl: env.RIB_BASE_URL,
    hmacSecret: env.RIB_HMAC_SECRET,
    timeoutMs: env.RIB_REQUEST_TIMEOUT_MS,
  };
}

export function loadBackgroundVettingConfig(
  source: EnvSource = process.env,
): BackgroundVettingServiceConfig {
  return {
    runtime: loadRuntimeConfig('background-vetting-service', source),
    rib: loadRibConfig(source),
  };
}
