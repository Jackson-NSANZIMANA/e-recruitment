// ══════════════════════════════════════════════════════════════════
// document-forensics-service — Configuration
//
// The amber-lane trigger. Retrieves a referenced document's REAL bytes from
// the object store (MinIO, hand-rolled SigV4 GET — retrieval only, the upload
// half belongs to the future portal slice), runs the bounded-real analyzer
// tier (ClamAV over clamd TCP + container/metadata parse + C2PA-manifest
// presence), writes the verdict to the owning agency's document_records and
// emits DOCUMENT_FORENSICS_COMPLETED. Needs: runtime, DB, the auth verify key
// (ingress is system-token only), the object store, and the scanner address.
// Env names follow the conventions already established in .env.example.
// No PII key — this service never touches applicant identity columns.
// ══════════════════════════════════════════════════════════════════

import {
  boolean,
  integer,
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

export interface DocumentForensicsConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
  readonly auth: AuthVerifyConfig;
  readonly objectStore: ObjectStoreConfig;
  readonly scanner: VirusScannerConfig;
}

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
      CLAMAV_HOST: withDefault(string({ minLength: 1 }), 'localhost'),
      CLAMAV_PORT: withDefault(integer({ min: 1, max: 65535 }), 3310),
      CLAMAV_TIMEOUT_MS: withDefault(integer({ min: 1000, max: 300000 }), 30000),
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
  };
}
