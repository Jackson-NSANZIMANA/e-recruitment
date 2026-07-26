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

// ── Applicant auth policy (ADR-018) ────────────────────────────────
/** OTP lifetime: 5 minutes — long enough for an SMS round trip, short
 * enough that an intercepted code is nearly worthless. */
export const OTP_TTL_SECONDS = 5 * 60;
/** Failed guesses before a challenge locks (a fresh request is the reset). */
export const OTP_MAX_ATTEMPTS = 5;
/** Applicant session lifetime: 30 minutes sliding — citizens check status
 * briefly; a shorter window than the officer hour bounds a stolen opaque
 * token, and the DB row makes revocation immediate anyway. */
export const APPLICANT_SESSION_TTL_SECONDS = 30 * 60;

/**
 * The applicant portal's machine identity (ADR-016 client credentials) and
 * the sibling-service endpoints the me-routes call. Loaded ONLY by main.ts —
 * proofs inject gateways directly, so the core never demands these vars.
 */
export interface ApplicantPortalConfig {
  readonly iamBaseUrl: string;
  readonly applicationBaseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export function loadApplicantPortalConfig(source: EnvSource = process.env): ApplicantPortalConfig {
  const env = loadEnv(
    {
      IAM_BASE_URL: url({ protocols: ['http', 'https'] }),
      APPLICATION_SERVICE_BASE_URL: url({ protocols: ['http', 'https'] }),
      IDENTITY_CLIENT_ID: string({ minLength: 1 }),
      IDENTITY_CLIENT_SECRET: string({ minLength: 8, secret: true }),
    },
    source,
  );
  return {
    iamBaseUrl: env.IAM_BASE_URL,
    applicationBaseUrl: env.APPLICATION_SERVICE_BASE_URL,
    clientId: env.IDENTITY_CLIENT_ID,
    clientSecret: env.IDENTITY_CLIENT_SECRET,
  };
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
