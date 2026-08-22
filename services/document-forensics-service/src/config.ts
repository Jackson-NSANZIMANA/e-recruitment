// ══════════════════════════════════════════════════════════════════
// document-forensics-service — Configuration
//
// Two front doors now:
//   • POST /v1/forensics/analyze  — analyze an object this service was HANDED a
//     reference to (system-internal; the bucket comes in the body).
//   • POST /v1/documents/upload   — INGEST real bytes from the citizen portal
//     (via the edge): scan → seal → store → verdict → emit.
//
// The upload door is why four long-standing variables stop being decoration:
//
//   MINIO_ENCRYPTION_KEY        REQUIRED, no default. It has promised
//     "AES-256-GCM key for document encryption (in production: HSM)" since the
//     beginning and nothing read it. A store for scanned national IDs that can
//     BOOT without its encryption key is a store that will run without one, and
//     nobody learns that until the bucket leaks. Making it optional would be
//     worse than absent: it would read as a control and behave as a preference.
//
//   MINIO_BUCKET_DOCUMENTS      the ingress destination. analyze/ still takes a
//     bucket in its body — its caller references objects this service does not
//     own — but an UPLOAD lands where this service decides, never where the
//     caller asks.
//
//   FORENSICS_MAX_FILE_SIZE_MB  both the file-length contract and the per-route
//     socket cap (Route.maxBodyBytes). The server-wide 64 KiB default stays
//     put, so no other route inherits a 10 MB payload budget.
//
//   FORENSICS_ALLOWED_MIME_TYPES  the declared-type allow-list. The bytes are
//     checked against the declaration separately — an allow-list on a
//     client-declared string is a courtesy, not a control.
//
// No PII key: this service never touches applicant identity columns.
// ══════════════════════════════════════════════════════════════════

import {
  boolean,
  integer,
  list,
  loadAuthVerifyConfig,
  loadDatabaseConfig,
  loadEnv,
  loadRuntimeConfig,
  string,
  withDefault,
  type AuthVerifyConfig,
  type DatabaseConfig,
  type EnvSource,
  type RuntimeConfig,
} from '@usrp/shared-config';

export interface ObjectStoreConfig {
  readonly endpoint: string;      // host only, e.g. "localhost" or "minio"
  readonly port: number;
  readonly useSsl: boolean;
  readonly accessKey: string;
  readonly secretKey: string;
}

export interface VirusScannerConfig {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
}

/** The upload ingress — destination, at-rest key, and admission limits. */
export interface DocumentIngressConfig {
  readonly bucket: string;
  /** Operator secret for the at-rest envelope. HKDF-derived, never used raw. */
  readonly encryptionKey: string;
  readonly maxFileSizeBytes: number;
  readonly allowedMediaTypes: readonly string[];
}

export interface DocumentForensicsConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
  readonly auth: AuthVerifyConfig;
  readonly objectStore: ObjectStoreConfig;
  readonly scanner: VirusScannerConfig;
  readonly ingress: DocumentIngressConfig;
}

const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_MEDIA_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'application/pdf'];

export function loadDocumentForensicsConfig(
  source: EnvSource = process.env,
): DocumentForensicsConfig {
  const env = loadEnv(
    {
      MINIO_ENDPOINT: withDefault(string({ minLength: 1 }), 'localhost'),
      MINIO_PORT: withDefault(integer({ min: 1, max: 65535 }), 9000),
      MINIO_USE_SSL: withDefault(boolean(), false),
      MINIO_ROOT_USER: string({ minLength: 3 }),
      MINIO_ROOT_PASSWORD: string({ minLength: 8 }),
      MINIO_BUCKET_DOCUMENTS: withDefault(string({ minLength: 3, maxLength: 100 }), 'usrp-documents'),
      // REQUIRED, and secret so it never reaches a log or an error message.
      MINIO_ENCRYPTION_KEY: string({ minLength: 32, secret: true }),
      CLAMAV_HOST: withDefault(string({ minLength: 1 }), 'localhost'),
      CLAMAV_PORT: withDefault(integer({ min: 1, max: 65535 }), 3310),
      CLAMAV_TIMEOUT_MS: withDefault(integer({ min: 1000, max: 300000 }), 30000),
      FORENSICS_MAX_FILE_SIZE_MB: withDefault(integer({ min: 1, max: 50 }), 10),
      FORENSICS_ALLOWED_MIME_TYPES: withDefault(list({ minItems: 1 }), DEFAULT_MEDIA_TYPES),
    },
    source,
  );

  return {
    runtime: loadRuntimeConfig('document-forensics-service', source),
    database: loadDatabaseConfig(source),
    auth: loadAuthVerifyConfig(source),
    objectStore: {
      endpoint: env.MINIO_ENDPOINT,
      port: env.MINIO_PORT,
      useSsl: env.MINIO_USE_SSL,
      accessKey: env.MINIO_ROOT_USER,
      secretKey: env.MINIO_ROOT_PASSWORD,
    },
    scanner: {
      host: env.CLAMAV_HOST,
      port: env.CLAMAV_PORT,
      timeoutMs: env.CLAMAV_TIMEOUT_MS,
    },
    ingress: {
      bucket: env.MINIO_BUCKET_DOCUMENTS,
      encryptionKey: env.MINIO_ENCRYPTION_KEY,
      maxFileSizeBytes: env.FORENSICS_MAX_FILE_SIZE_MB * BYTES_PER_MB,
      allowedMediaTypes: env.FORENSICS_ALLOWED_MIME_TYPES,
    },
  };
}
