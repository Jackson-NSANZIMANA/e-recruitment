// ══════════════════════════════════════════════════════════════════
// audit-service — Configuration
//
// The leanest config in the platform, by design. The audit sink calls no G2G
// agency (no NIDA/NESA/HEC secret) and decrypts no PII (no encryption key) —
// it records references and derived facts only. It needs exactly: runtime
// (service name, port for health/readiness) and the database (where the
// immutable trail lives). Demanding nothing more keeps its blast radius small.
// ══════════════════════════════════════════════════════════════════

import {
  loadDatabaseConfig,
  loadRuntimeConfig,
  type DatabaseConfig,
  type EnvSource,
  type RuntimeConfig,
} from '@usrp/shared-config';

export interface AuditServiceConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
}

export function loadAuditConfig(source: EnvSource = process.env): AuditServiceConfig {
  return {
    runtime: loadRuntimeConfig('audit-service', source),
    database: loadDatabaseConfig(source),
  };
}
