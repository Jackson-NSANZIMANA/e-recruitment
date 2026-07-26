// ══════════════════════════════════════════════════════════════════
// iam-service — Configuration
//
// Lean by intent, like audit-service. iam-service MINTS tokens; it does not
// verify inbound ones (its only route, login, is public), so it loads the
// issuer PRIVATE key and nothing else auth-related — no public verifier, no
// G2G secret, no PII encryption key. It needs exactly: runtime, the database
// (the credential store), and the issuer signing key.
// ══════════════════════════════════════════════════════════════════

import {
  loadAuthIssuerConfig,
  loadDatabaseConfig,
  loadRuntimeConfig,
  type AuthIssuerConfig,
  type DatabaseConfig,
  type EnvSource,
  type RuntimeConfig,
} from '@usrp/shared-config';

/**
 * Officer bearer-token lifetime. 1h (owner-decided, 2026-07-12): short enough
 * to bound a stolen-token window before a refresh-token mechanism exists.
 */
export const OFFICER_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * System bearer-token lifetime. 15 min (owner D3, 2026-07-26): machine
 * clients re-fetch silently, so shorter is free and bounds a stolen-token
 * window far tighter than the human 1h.
 */
export const SYSTEM_TOKEN_TTL_SECONDS = 15 * 60;

export interface IamServiceConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
  /** The issuer PRIVATE key — iam-service is the SOLE minter. */
  readonly issuer: AuthIssuerConfig;
}

export function loadIamConfig(source: EnvSource = process.env): IamServiceConfig {
  return {
    runtime: loadRuntimeConfig('iam-service', source),
    database: loadDatabaseConfig(source),
    issuer: loadAuthIssuerConfig(source),
  };
}
