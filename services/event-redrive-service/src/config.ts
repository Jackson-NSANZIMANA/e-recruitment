// ══════════════════════════════════════════════════════════════════
// event-redrive-service — Configuration
//
// Four knobs, all of them the owner's decisions expressed as numbers
// (ADR-050 §2), plus the runtime and database every service needs.
//
// REDRIVE_INTERVAL_MS is the TICK, not the schedule: the schedule lives in the
// ledger (one next_attempt_at per letter), so a slow tick delays a re-drive but
// never changes the plan. The sandbox compresses the delays to seconds.
// ══════════════════════════════════════════════════════════════════

import {
  integer,
  list,
  loadDatabaseConfig,
  loadKafkaConfig,
  loadRuntimeConfig,
  loadEnv,
  withDefault,
  type DatabaseConfig,
  type EnvSource,
  type KafkaConfig,
  type RuntimeConfig,
} from '@usrp/shared-config';
import { DEFAULT_REDRIVE_DELAYS_MS, resolveRedrivePolicy, type RedrivePolicy } from '@usrp/shared-events';

export interface EventRedriveConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
  readonly kafka: KafkaConfig;
  readonly policy: RedrivePolicy;
  /** How often the worker looks for due letters. */
  readonly tickIntervalMs: number;
  /**
   * The Postgres advisory-lock key. Two workers started by mistake must not
   * double-publish, and an advisory lock is the idiom the platform already uses
   * for single-leader work.
   */
  readonly leaderLockKey: number;
}

export function loadEventRedriveConfig(source: EnvSource = process.env): EventRedriveConfig {
  const env = loadEnv(
    {
      REDRIVE_TICK_INTERVAL_MS: withDefault(integer({ min: 1_000, max: 3_600_000 }), 30_000),
      /** Comma-separated ms delays; the default is 1m,5m,15m,1h,3h,6h. */
      REDRIVE_DELAYS_MS: withDefault(list({ minItems: 1 }), DEFAULT_REDRIVE_DELAYS_MS.map(String)),
      REDRIVE_GROUP_FAILURE_THRESHOLD: withDefault(integer({ min: 1, max: 100 }), 3),
      REDRIVE_MAX_PER_TICK: withDefault(integer({ min: 1, max: 10_000 }), 50),
      REDRIVE_LEADER_LOCK_KEY: withDefault(integer({ min: 1 }), 4_050_001),
    },
    source,
  );

  const delaysMs = env.REDRIVE_DELAYS_MS.map((raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`REDRIVE_DELAYS_MS entries must be positive integers, got "${raw}"`);
    }
    return value;
  });

  return {
    runtime: loadRuntimeConfig('event-redrive-service', source),
    database: loadDatabaseConfig(source),
    kafka: loadKafkaConfig('event-redrive-service', source),
    policy: resolveRedrivePolicy({
      delaysMs,
      groupFailureThreshold: env.REDRIVE_GROUP_FAILURE_THRESHOLD,
      maxPerTick: env.REDRIVE_MAX_PER_TICK,
    }),
    tickIntervalMs: env.REDRIVE_TICK_INTERVAL_MS,
    leaderLockKey: env.REDRIVE_LEADER_LOCK_KEY,
  };
}
