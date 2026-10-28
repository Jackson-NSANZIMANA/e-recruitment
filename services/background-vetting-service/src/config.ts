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
  EnvValidationError,
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
  /** The criminal-clearance source. */
  readonly mode: ClearanceMode;
}

/**
 * RIB_HASH           the original path: RIB looked up by nationalIdHash on
 *                    APPLICANT_SUBMITTED. DB-free.
 * IREMBO_CERTIFICATE ADR-048 §2.3: the applicant gives the number of their Irembo
 *                    criminal-record certificate; verified, then bound to their
 *                    NIDA identity. Needs the database (identity read, rls/0040).
 */
export type ClearanceMode = 'RIB_HASH' | 'IREMBO_CERTIFICATE';

export interface ClearanceCertificateConfig {
  readonly baseUrl: string;
  readonly clientToken: string;
  readonly timeoutMs: number;
  readonly allowedTypes: ReadonlySet<string>;
  readonly noRecordTypes: ReadonlySet<string>;
  readonly validityDays: number;
  readonly referenceHmacKey: string;
  readonly encryptionKey: string;
}

/**
 * Owner decisions (ADR-048 §2.3, defaults taken, owner to confirm):
 *   • validity 90 days before submission;
 *   • the Irembo APPLICATION_CODE allowlist is configuration, required and
 *     never defaulted: the sandbox sets clearly named placeholders;
 *   • no distinct "no record" type unless configured, so content review is human.
 */
export const DEFAULT_CLEARANCE_VALIDITY_DAYS = 90;

function codes(raw: string | undefined): ReadonlySet<string> {
  return new Set((raw ?? '').split(',').map((c) => c.trim()).filter((c) => c !== ''));
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

export function loadClearanceMode(source: EnvSource = process.env): ClearanceMode {
  const raw = (source['CLEARANCE_MODE'] ?? 'RIB_HASH').trim();
  if (raw !== 'RIB_HASH' && raw !== 'IREMBO_CERTIFICATE') {
    throw new EnvValidationError(['CLEARANCE_MODE must be RIB_HASH or IREMBO_CERTIFICATE.']);
  }
  return raw;
}

export function loadClearanceCertificateConfig(source: EnvSource = process.env): ClearanceCertificateConfig {
  const env = loadEnv(
    {
      IREMBO_CERTIFICATES_BASE_URL: url({ protocols: ['http', 'https'] }),
      IREMBO_CERTIFICATES_CLIENT_TOKEN: string({ minLength: 8, secret: true }),
      IREMBO_CERTIFICATES_TIMEOUT_MS: withDefault(integer({ min: 500, max: 60_000 }), 5_000),
      CLEARANCE_ALLOWED_APPLICATION_CODES: string({ minLength: 3 }),
      CLEARANCE_NO_RECORD_APPLICATION_CODES: withDefault(string(), ''),
      CLEARANCE_VALIDITY_DAYS: withDefault(integer({ min: 1, max: 3_650 }), DEFAULT_CLEARANCE_VALIDITY_DAYS),
      CLEARANCE_REFERENCE_HMAC_KEY: string({ minLength: 32, secret: true }),
      PII_ENCRYPTION_KEY: string({ minLength: 32, secret: true }),
    },
    source,
  );
  const allowedTypes = codes(env.CLEARANCE_ALLOWED_APPLICATION_CODES);
  const noRecordTypes = codes(env.CLEARANCE_NO_RECORD_APPLICATION_CODES);
  for (const code of [...allowedTypes, ...noRecordTypes]) {
    if (!/^[A-Z0-9_]+$/.test(code)) throw new EnvValidationError(['Clearance application codes must be upper-case letters, digits and underscores.']);
  }
  for (const code of noRecordTypes) {
    if (!allowedTypes.has(code)) throw new EnvValidationError(['CLEARANCE_NO_RECORD_APPLICATION_CODES must be a subset of CLEARANCE_ALLOWED_APPLICATION_CODES.']);
  }
  return {
    baseUrl: env.IREMBO_CERTIFICATES_BASE_URL,
    clientToken: env.IREMBO_CERTIFICATES_CLIENT_TOKEN,
    timeoutMs: env.IREMBO_CERTIFICATES_TIMEOUT_MS,
    allowedTypes,
    noRecordTypes,
    validityDays: env.CLEARANCE_VALIDITY_DAYS,
    referenceHmacKey: env.CLEARANCE_REFERENCE_HMAC_KEY,
    encryptionKey: env.PII_ENCRYPTION_KEY,
  };
}

export function loadBackgroundVettingConfig(
  source: EnvSource = process.env,
): BackgroundVettingServiceConfig {
  const mode = loadClearanceMode(source);
  return {
    runtime: loadRuntimeConfig('background-vetting-service', source),
    // The RIB-by-hash endpoint is only required on the RIB path.
    rib: mode === 'RIB_HASH' ? loadRibConfig(source) : { baseUrl: '', hmacSecret: '', timeoutMs: 0 },
    mode,
  };
}
