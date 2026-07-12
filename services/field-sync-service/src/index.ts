// ══════════════════════════════════════════════════════════════════
// @usrp/field-sync-service — Public API & composition root
//
// Wires the three use cases (enroll / sync / resolve) to their PostgreSQL
// adapters over one event bus. field-sync-service OWNS physical_test_scores and
// field_devices (ADR-006 / ADR-010): it verifies, merges, and writes score
// rows, then EMITS field.score.captured — application-service projects the
// application-state transition. The caller supplies the EventBus (InMemory in
// tests, Kafka in prod). Transport (HTTP) is composed in main.ts, not here.
// ══════════════════════════════════════════════════════════════════

import type { EventBus } from '@usrp/shared-events';
import { PgDeviceRegistry } from './adapters/device-registry.pg.js';
import { PgFieldScoreStore } from './adapters/field-score-store.pg.js';
import { EnrollDeviceService } from './application/enroll-device.service.js';
import { SyncFieldScoresService } from './application/sync-field-scores.service.js';
import { ResolveConflictService } from './application/resolve-conflict.service.js';
import type { FieldSyncServiceConfig } from './config.js';

export interface FieldSyncService {
  readonly enrollDevice: EnrollDeviceService;
  readonly syncFieldScores: SyncFieldScoresService;
  readonly resolveConflict: ResolveConflictService;
}

export function createFieldSyncService(
  _config: FieldSyncServiceConfig,
  eventBus: EventBus,
): FieldSyncService {
  const registry = new PgDeviceRegistry();
  const store = new PgFieldScoreStore();
  return {
    enrollDevice: new EnrollDeviceService({ registry, eventBus }),
    syncFieldScores: new SyncFieldScoresService({ registry, store, eventBus }),
    resolveConflict: new ResolveConflictService({ store, eventBus }),
  };
}

// ── Re-exports ────────────────────────────────────────────────────
export { EnrollDeviceService } from './application/enroll-device.service.js';
export { SyncFieldScoresService } from './application/sync-field-scores.service.js';
export { ResolveConflictService } from './application/resolve-conflict.service.js';
export type {
  EnrollDeviceCommand,
  EnrollDeviceDeps,
} from './application/enroll-device.service.js';
export type {
  SyncFieldScoresCommand,
  SyncFieldScoresDeps,
  SyncFieldScoresOutcome,
  RecordSyncResult,
  RecordStatus,
  RejectReason,
} from './application/sync-field-scores.service.js';
export type {
  ResolveConflictCommand,
  ResolveConflictDeps,
} from './application/resolve-conflict.service.js';

export { ENROLL_DEVICE_PATH, enrollDeviceRoute } from './adapters/http/enroll-device.controller.js';
export { SYNC_SCORES_PATH, syncScoresRoute } from './adapters/http/sync-scores.controller.js';
export {
  RESOLVE_CONFLICT_PATH,
  resolveConflictRoute,
} from './adapters/http/resolve-conflict.controller.js';

export { PgDeviceRegistry } from './adapters/device-registry.pg.js';
export { PgFieldScoreStore } from './adapters/field-score-store.pg.js';

export { compareClocks, mergeVectorClock } from './domain/vector-clock.js';
export type { VectorClock, ClockRelation } from './domain/vector-clock.js';
export { decideMerge, computeHeads } from './domain/merge.js';
export type { MergeDecision, StoredRecordRef } from './domain/merge.js';
export { OPS_SCHEMA } from './domain/agency-schema.js';
export { FieldSyncPersistenceError } from './domain/field-sync.errors.js';

export { loadFieldSyncConfig } from './config.js';
export type { FieldSyncServiceConfig } from './config.js';
export type {
  DeviceRegistry,
  DeviceRecord,
  EnrollDeviceInput,
  EnrollOutcome,
} from './ports/device-registry.js';
export type {
  FieldScoreStore,
  SyncRecordInput,
  SyncOutcome,
  ResolveConflictInput,
  ResolveOutcome,
  ResolvedRecord,
  CapturedContext,
} from './ports/field-score-store.js';
