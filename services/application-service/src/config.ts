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
  boolean,
  integer,
  loadAuthVerifyConfig,
  loadDatabaseConfig,
  loadEnv,
  loadRuntimeConfig,
  withDefault,
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
  /** Separation-of-duties rules enforced per application (BUILD-004 §D). */
  readonly separationOfDuties: SeparationOfDutiesConfig;
  /** The stalled-clearance re-announce sweep (scheduling deferrals). */
  readonly slotRetry: SlotRetryConfig;
}

/**
 * How often applications stuck at DOCUMENT_REVIEW_GREEN without a slot are
 * offered to scheduling again. intervalMs = 0 disables the sweep.
 */
export interface SlotRetryConfig {
  readonly intervalMs: number;
  readonly graceMs: number;
  readonly batchSize: number;
}

export function loadSlotRetryConfig(source: EnvSource = process.env): SlotRetryConfig {
  const env = loadEnv(
    {
      SLOT_RETRY_INTERVAL_MS: withDefault(integer({ min: 0 }), 15 * 60_000),
      SLOT_RETRY_GRACE_MS: withDefault(integer({ min: 60_000 }), 6 * 60 * 60_000),
      SLOT_RETRY_BATCH_SIZE: withDefault(integer({ min: 1, max: 1000 }), 200),
    },
    source,
  );
  return {
    intervalMs: env.SLOT_RETRY_INTERVAL_MS,
    graceMs: env.SLOT_RETRY_GRACE_MS,
    batchSize: env.SLOT_RETRY_BATCH_SIZE,
  };
}

/**
 * Which four-eyes rules the transition repository enforces. These are POLICY
 * switches owned by the agencies, not engineering preferences: the defaults
 * are the rule the roadmap states (the officer who recorded the medical
 * verdict may not also sign the final decision); the second is available but
 * off until a policy owner ratifies it.
 */
export interface SeparationOfDutiesConfig {
  /** The officer who moved an application into MEDICAL_REVIEW may not finalise it. */
  readonly finalDecisionExcludesMedicalReviewer: boolean;
  /** The officer who signed the final decision may not also accept the applicant. */
  readonly acceptExcludesFinalDecider: boolean;
}

export function loadSeparationOfDutiesConfig(
  source: EnvSource = process.env,
): SeparationOfDutiesConfig {
  const env = loadEnv(
    {
      SOD_FINAL_DECISION_EXCLUDES_MEDICAL_REVIEWER: withDefault(boolean(), true),
      SOD_ACCEPT_EXCLUDES_FINAL_DECIDER: withDefault(boolean(), false),
    },
    source,
  );
  return {
    finalDecisionExcludesMedicalReviewer: env.SOD_FINAL_DECISION_EXCLUDES_MEDICAL_REVIEWER,
    acceptExcludesFinalDecider: env.SOD_ACCEPT_EXCLUDES_FINAL_DECIDER,
  };
}

export function loadApplicationConfig(source: EnvSource = process.env): ApplicationServiceConfig {
  return {
    runtime: loadRuntimeConfig('application-service', source),
    database: loadDatabaseConfig(source),
    auth: loadAuthVerifyConfig(source),
    separationOfDuties: loadSeparationOfDutiesConfig(source),
    slotRetry: loadSlotRetryConfig(source),
  };
}
