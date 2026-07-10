// ══════════════════════════════════════════════════════════════════
// notification-service — Configuration
//
// A lean config. The service consumes slot.assigned and delivers the exam
// invitation through a channel adapter. It needs runtime (name, health port)
// and the database (readiness + future contact resolution). It calls no G2G
// agency and — today — decrypts no PII (no deliverable contact is stored yet;
// see the ContactResolver note). Channel credentials will layer on when a real
// SMS/email provider replaces the log adapter.
// ══════════════════════════════════════════════════════════════════

import {
  loadDatabaseConfig,
  loadRuntimeConfig,
  type DatabaseConfig,
  type EnvSource,
  type RuntimeConfig,
} from '@usrp/shared-config';

export interface NotificationServiceConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
}

export function loadNotificationConfig(source: EnvSource = process.env): NotificationServiceConfig {
  return {
    runtime: loadRuntimeConfig('notification-service', source),
    database: loadDatabaseConfig(source),
  };
}
