// ══════════════════════════════════════════════════════════════════
// application-service — Configuration
//
// A lean config, by intent. The front door reads only the applicant's
// unencrypted identity status + national_id_hash and writes non-PII
// application data — it calls no G2G agency (no NIDA/NESA/HEC secret) and
// decrypts no PII (no encryption key). It needs exactly: runtime (service
// name, port) and the database (where identities, campaigns, and the
// agency-partitioned applications live). Demanding nothing more keeps its
// blast radius small — the same discipline as audit-service.
// ══════════════════════════════════════════════════════════════════

import {
  loadAuthVerifyConfig,
  loadDatabaseConfig,
  loadRuntimeConfig,
  type AuthVerifyConfig,
  type DatabaseConfig,
  type EnvSource,
  type RuntimeConfig,
} from '@usrp/shared-config';

export interface ApplicationServiceConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
  /** Ingress auth: the issuer public key + issuer/audience used to verify
   *  inbound bearer tokens. Mandatory — every HTTP route is now authenticated. */
  readonly auth: AuthVerifyConfig;
}

export function loadApplicationConfig(source: EnvSource = process.env): ApplicationServiceConfig {
  return {
    runtime: loadRuntimeConfig('application-service', source),
    database: loadDatabaseConfig(source),
    auth: loadAuthVerifyConfig(source),
  };
}
