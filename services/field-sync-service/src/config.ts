// ══════════════════════════════════════════════════════════════════
// field-sync-service — Configuration
//
// Owns the physical_test_scores CRDT log and the field_devices registry, so it
// needs the database. Every ingress is officer-authenticated, so it needs the
// auth verify key. It calls no G2G agency and decrypts no PII (scores are not
// PII; device keys are public) — so no G2G secret, no encryption key. The
// signature trust anchor is per-device (public keys in the registry), not a
// single service key, so — unlike biometric — it needs no QR/issuer key either.
// Runtime + database + auth: nothing more, keeping the blast radius small.
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

export interface FieldSyncServiceConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
  /** Ingress auth: issuer public key + issuer/audience for inbound bearer tokens. */
  readonly auth: AuthVerifyConfig;
}

export function loadFieldSyncConfig(source: EnvSource = process.env): FieldSyncServiceConfig {
  return {
    runtime: loadRuntimeConfig('field-sync-service', source),
    database: loadDatabaseConfig(source),
    auth: loadAuthVerifyConfig(source),
  };
}
