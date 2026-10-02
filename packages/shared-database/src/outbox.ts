// ══════════════════════════════════════════════════════════════════
// @usrp/shared-database — Transactional event outbox (ADR-025, lifted ADR-026)
//
// Three parts over public_core.event_outbox (rls/0020):
//
//   stageOutboxEvents()  INSERTs events inside the CALLER's transaction. The
//                        only write path into the outbox; a duplicate eventId
//                        violates the UNIQUE and aborts the whole transaction.
//
//   PgOutboxDispatcher   post-commit fast path. Publishes each event and stamps
//                        published_at. On the first transport failure it STOPS
//                        (a later event must not overtake an earlier one) and
//                        leaves the rest to the relay. Never throws for that.
//
//   PgOutboxRelay        the guarantee. Polls ONE producer's pending rows in id
//                        order and publishes them. One active relay per
//                        producer across replicas (transaction-scoped advisory
//                        lock), so relayed order is commit order. A failed
//                        publish records attempts/last_error and ends the
//                        batch; the next tick retries from the same row.
//
// WHY IT LIVES HERE, STRUCTURALLY TYPED. ADR-025 said to lift this out of
// application-service when a second service adopted it; scheduling-service is
// that second service (ADR-026). It is typed against the two properties it
// actually reads (eventId, eventType) and a publisher with one method, so this
// package gains NO dependency on @usrp/shared-events: the lockfile is untouched
// and the dependency graph keeps pointing one way. A KafkaEventBus or an
// InMemoryEventBus satisfies OutboxPublisher<USRPEvent> as-is.
//
// DELIVERY IS AT-LEAST-ONCE. A crash between publish and stamp republishes,
// and the dispatcher and relay can both publish a row the grace window did not
// separate. Consumers are idempotent by contract.
//
// Every statement runs as usrp_system_service, the outbox's only grantee.
// ══════════════════════════════════════════════════════════════════

import { asJsonb, sql } from './client.js';
import type { SqlTransaction } from './transaction.js';

const SYSTEM_ROLE = 'usrp_system_service';
const PURGE_EVERY_MS = 60 * 60 * 1000;
const PURGE_BATCH = 5_000;

/** The two properties of an event the outbox reads. Every USRPEvent has both. */
export interface OutboxEvent {
  readonly eventId: string;
  readonly eventType: string;
}

/** Anything that can put one event on the wire. An EventBus qualifies. */
export interface OutboxPublisher<E extends OutboxEvent> {
  publish(event: E): Promise<void>;
}

/**
 * Operator-facing error text: name + message only, truncated to fit
 * event_outbox.last_error (varchar 512). Never a stack, never a `cause` chain
 * (driver errors can carry row values).
 */
export function describeOutboxError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw.length > 512 ? `${raw.slice(0, 509)}...` : raw;
}

function assertProducer(producer: string): void {
  if (producer.trim() === '' || producer.length > 64) {
    throw new RangeError(`outbox producer must be 1..64 chars, got ${JSON.stringify(producer)}`);
  }
}

/**
 * Persist `events` inside the caller's open transaction. Call it LAST, after
 * every state write, so nothing after it can fail and leave a staged event
 * for a state change that was rolled back (the rollback would take both).
 */
export async function stageOutboxEvents(
  tx: SqlTransaction,
  events: readonly OutboxEvent[],
  producer: string,
): Promise<void> {
  assertProducer(producer);
  for (const event of events) {
    await tx`
      INSERT INTO public_core.event_outbox (event_id, event_type, producer, payload)
      VALUES (${event.eventId}, ${event.eventType}, ${producer}, ${tx.json(asJsonb(event))})
    `;
  }
}

async function markPublished(eventId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
    await tx`
      UPDATE public_core.event_outbox
      SET published_at = now(), attempts = attempts + 1, last_error = NULL
      WHERE event_id = ${eventId} AND published_at IS NULL
    `;
  });
}

export class PgOutboxDispatcher<E extends OutboxEvent> {
  readonly #publisher: OutboxPublisher<E>;
  readonly #producer: string;

  constructor(publisher: OutboxPublisher<E>, producer: string) {
    assertProducer(producer);
    this.#publisher = publisher;
    this.#producer = producer;
  }

  /**
   * Publish events that are ALREADY durable (staged in a committed
   * transaction). Never throws for a transport fault: the relay owns delivery.
   * Also safe for a byte-identical RE-ANNOUNCEMENT of an event whose outbox
   * row was long since published or purged: the stamp is then a no-op.
   */
  async dispatch(events: readonly E[]): Promise<void> {
    for (const event of events) {
      try {
        await this.#publisher.publish(event);
      } catch (error) {
        // Durable already. Stop here so this event's successors cannot be
        // published ahead of it; the relay delivers all of them in id order.
        console.warn(
          JSON.stringify({
            msg: 'outbox_dispatch_deferred',
            producer: this.#producer,
            eventId: event.eventId,
            eventType: event.eventType,
            error: describeOutboxError(error),
          }),
        );
        return;
      }
      try {
        await markPublished(event.eventId);
      } catch (error) {
        // Published but not stamped: the relay will publish it once more.
        // At-least-once, by design; never worth failing the caller over.
        console.warn(
          JSON.stringify({
            msg: 'outbox_mark_published_failed',
            producer: this.#producer,
            eventId: event.eventId,
            error: describeOutboxError(error),
          }),
        );
      }
    }
  }
}

export interface OutboxRelayOptions {
  /** The producer whose rows this relay drains. Required: relays never share. */
  readonly producer: string;
  /**
   * Envelope guard for stored payloads. A row that fails it is quarantined in
   * place (attempts + last_error) instead of being published or blocking.
   */
  readonly isValid: (payload: unknown) => boolean;
  /** Pause between drain ticks. */
  readonly pollIntervalMs?: number;
  /** Rows per tick. */
  readonly batchSize?: number;
  /**
   * Rows younger than this are left to the dispatcher's fast path, so the two
   * rarely publish the same row. Proofs set 0 to drain deterministically.
   */
  readonly graceMs?: number;
  /** Published rows older than this are purged. */
  readonly retentionDays?: number;
}

export interface DrainResult {
  readonly published: number;
  /** True when a publish failed and the batch stopped at that row. */
  readonly blocked: boolean;
}

interface PendingRow {
  readonly id: string;
  readonly event_id: string;
  readonly payload: unknown;
}

export class PgOutboxRelay<E extends OutboxEvent> {
  readonly #publisher: OutboxPublisher<E>;
  readonly #producer: string;
  readonly #isValid: (payload: unknown) => boolean;
  readonly #pollIntervalMs: number;
  readonly #batchSize: number;
  readonly #graceMs: number;
  readonly #retentionDays: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<void> | undefined;
  #running = false;
  #lastPurgeAt = 0;

  constructor(publisher: OutboxPublisher<E>, options: OutboxRelayOptions) {
    assertProducer(options.producer);
    this.#publisher = publisher;
    this.#producer = options.producer;
    this.#isValid = options.isValid;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#batchSize = options.batchSize ?? 100;
    this.#graceMs = options.graceMs ?? 5_000;
    this.#retentionDays = options.retentionDays ?? 7;
  }

  /** Begin polling. Idempotent. The timer is unref'd: it never holds a process open. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#schedule(0);
  }

  /** Stop polling and wait for an in-flight tick to finish. */
  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#inFlight;
  }

  #schedule(delayMs: number): void {
    this.#timer = setTimeout(() => {
      this.#inFlight = this.#tick().finally(() => {
        this.#inFlight = undefined;
        if (this.#running) this.#schedule(this.#pollIntervalMs);
      });
    }, delayMs);
    this.#timer.unref();
  }

  async #tick(): Promise<void> {
    try {
      await this.drainOnce();
      await this.#purgeIfDue();
    } catch (error) {
      // A database outage lands here. Log and keep ticking: the rows are
      // durable, and the next tick resumes exactly where this one stopped.
      console.error(
        JSON.stringify({ msg: 'outbox_relay_error', producer: this.#producer, error: describeOutboxError(error) }),
      );
    }
  }

  /** One drain pass. Public so proofs and operators can drive it directly. */
  async drainOnce(): Promise<DrainResult> {
    return await sql.begin(async (tx): Promise<DrainResult> => {
      await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

      // One relay per producer at a time, cluster-wide. Released at COMMIT.
      const lock = await tx<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${`usrp:event-outbox:${this.#producer}`}, 0)) AS locked
      `;
      if (lock[0]?.locked !== true) return { published: 0, blocked: false };

      const rows = await tx<PendingRow[]>`
        SELECT id, event_id, payload
        FROM public_core.event_outbox
        WHERE producer = ${this.#producer}
          AND published_at IS NULL
          AND created_at <= now() - (${this.#graceMs}::int * interval '1 millisecond')
        ORDER BY id
        LIMIT ${this.#batchSize}
        FOR UPDATE
      `;

      let published = 0;
      for (const row of rows) {
        if (!this.#isValid(row.payload)) {
          // Cannot happen through stageOutboxEvents. If it does (manual edit,
          // corruption) quarantine in place and keep the pipeline moving.
          await tx`
            UPDATE public_core.event_outbox
            SET attempts = attempts + 1, last_error = 'stored payload is not a valid USRP event envelope'
            WHERE id = ${row.id}
          `;
          console.error(JSON.stringify({ msg: 'outbox_row_invalid', producer: this.#producer, eventId: row.event_id }));
          continue;
        }

        try {
          await this.#publisher.publish(row.payload as E);
        } catch (error) {
          await tx`
            UPDATE public_core.event_outbox
            SET attempts = attempts + 1, last_error = ${describeOutboxError(error)}
            WHERE id = ${row.id}
          `;
          console.warn(
            JSON.stringify({
              msg: 'outbox_relay_blocked',
              producer: this.#producer,
              eventId: row.event_id,
              publishedThisTick: published,
              error: describeOutboxError(error),
            }),
          );
          return { published, blocked: true };
        }

        await tx`
          UPDATE public_core.event_outbox
          SET published_at = now(), attempts = attempts + 1, last_error = NULL
          WHERE id = ${row.id}
        `;
        published += 1;
      }

      if (published > 0) {
        console.log(JSON.stringify({ msg: 'outbox_relayed', producer: this.#producer, published }));
      }
      return { published, blocked: false };
    });
  }

  async #purgeIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.#lastPurgeAt < PURGE_EVERY_MS) return;
    this.#lastPurgeAt = now;
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
      await tx`
        DELETE FROM public_core.event_outbox
        WHERE id IN (
          SELECT id FROM public_core.event_outbox
          WHERE producer = ${this.#producer}
            AND published_at IS NOT NULL
            AND published_at < now() - (${this.#retentionDays}::int * interval '1 day')
          ORDER BY id
          LIMIT ${PURGE_BATCH}
        )
      `;
    });
  }
}
