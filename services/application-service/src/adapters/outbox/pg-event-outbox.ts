// ══════════════════════════════════════════════════════════════════
// application-service — outbox binding (ADR-025; implementation lifted, ADR-026)
//
// The outbox itself now lives in @usrp/shared-database (stageOutboxEvents,
// PgOutboxDispatcher, PgOutboxRelay) because scheduling-service became its
// second adopter. This file binds it to THIS service: the producer name, the
// USRPEvent type and the shared-events envelope guard.
//
// The exported surface is unchanged on purpose, so the repository, index.ts,
// main.ts and verify-outbox-slice.ts did not have to move:
//   OUTBOX_PRODUCER, stageEvents(tx, events, producer?),
//   PgOutboxDispatcher(bus, producer?), PgOutboxRelay(bus, options?),
//   DrainResult, OutboxRelayOptions.
// ══════════════════════════════════════════════════════════════════

import {
  PgOutboxDispatcher as SharedOutboxDispatcher,
  PgOutboxRelay as SharedOutboxRelay,
  stageOutboxEvents,
  type DrainResult,
  type SqlTransaction,
} from '@usrp/shared-database';
import { hasValidEnvelope, type EventBus } from '@usrp/shared-events';
import type { USRPEvent } from '@usrp/shared-types';
import type { EventDispatcher } from '../../ports/event-outbox.js';

/** This service's rows. Each producer relays only its own. */
export const OUTBOX_PRODUCER = 'application-service';

export type { DrainResult };

/**
 * Persist `events` inside the caller's open transaction. Call it LAST, after
 * every state write (see stageOutboxEvents).
 */
export async function stageEvents(
  tx: SqlTransaction,
  events: readonly USRPEvent[],
  producer: string = OUTBOX_PRODUCER,
): Promise<void> {
  await stageOutboxEvents(tx, events, producer);
}

export class PgOutboxDispatcher extends SharedOutboxDispatcher<USRPEvent> implements EventDispatcher {
  constructor(bus: EventBus, producer: string = OUTBOX_PRODUCER) {
    super(bus, producer);
  }
}

export interface OutboxRelayOptions {
  readonly producer?: string;
  readonly pollIntervalMs?: number;
  readonly batchSize?: number;
  readonly graceMs?: number;
  readonly retentionDays?: number;
}

export class PgOutboxRelay extends SharedOutboxRelay<USRPEvent> {
  constructor(bus: EventBus, options: OutboxRelayOptions = {}) {
    super(bus, {
      ...options,
      producer: options.producer ?? OUTBOX_PRODUCER,
      isValid: (payload: unknown): boolean => hasValidEnvelope(payload),
    });
  }
}
