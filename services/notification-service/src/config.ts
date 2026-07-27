// ══════════════════════════════════════════════════════════════════
// notification-service — Configuration
//
// A lean config. The service consumes slot.assigned and delivers the exam
// invitation through the SMS channel adapter. It needs runtime (name, health
// port), the database (readiness + contact resolution), and — since ADR-021 —
// the pgcrypto key so PgContactResolver can decrypt the stored contact.
// Only PII_ENCRYPTION_KEY is demanded (eligibility-service precedent), not
// the full SecurityConfig: this service has no use for the NID HMAC key.
// Channel credentials will layer on when a real SMS provider replaces the
// log adapter.
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

export interface NotificationSecurityConfig {
  /** pgcrypto symmetric key set as the `app.encryption_key` session var. */
  readonly encryptionKey: string;
}

export interface NotificationServiceConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
  readonly security: NotificationSecurityConfig;
}

export function loadNotificationConfig(source: EnvSource = process.env): NotificationServiceConfig {
  const env = loadEnv({ PII_ENCRYPTION_KEY: string({ minLength: 32, secret: true }) }, source);
  return {
    runtime: loadRuntimeConfig('notification-service', source),
    database: loadDatabaseConfig(source),
    security: { encryptionKey: env.PII_ENCRYPTION_KEY },
  };
}
