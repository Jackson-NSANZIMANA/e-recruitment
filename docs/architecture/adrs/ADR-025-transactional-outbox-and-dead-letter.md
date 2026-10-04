# ADR-025 — Transactional outbox and dead-letter containment

**Status:** accepted (wave 2 of the P0 hardening programme)
**Date:** 2026-10-01
**Supersedes:** the implicit "commit, then publish" convention used by every producer

## Context: two defects that fail silently, behind green healthchecks

### 1. Commit-then-publish loses events, and idempotency makes the loss permanent

Every producer did `COMMIT state` followed by `bus.publish(event)`. Two writes to
two systems with nothing binding them. A process crash, a broker refusal or a
network partition between the two leaves the state recorded and the event gone.

That would merely be bad, except the consumers are correctly idempotent. In
`ProjectVettingResultService` the sequence was: commit the transition into
`DOCUMENT_REVIEW_GREEN`, publish `AUDIT_ENTRY`, publish
`APPLICATION_ELIGIBILITY_CLEARED`. If the CLEARED publish failed, the verdict
was redelivered, the repository returned `NO_CHANGE` (the row was already
GREEN), and **CLEARED was never produced again**. Scheduling never heard. The
applicant sits at GREEN, cleared on all three gates, and is never assigned an
exam slot. No error, no retry, no alert.

The front door had the same shape with a different symptom: a broker hiccup
after the commit returned `500` for an application that *was* filed, telling the
citizen to file it again, while the filed one never entered vetting.

### 2. One poison message freezes its partition forever

`KafkaEventBus.subscribe` ran `deserialize` and the handler with no error
boundary. kafkajs treats any throw from `eachMessage` as "retry": it restarts
the consumer and redelivers the same offset, indefinitely. A malformed payload,
or an event a handler deterministically cannot process, therefore stops every
event behind it on that partition. Partitions are keyed by `applicantId`, so
this is not one stuck citizen; it is a fixed slice of every applicant hashed
there, on that topic, for as long as the message exists.

## Decision

### Outbox (`public_core.event_outbox`, `rls/0020`)

1. **Stage in the state transaction.** Repository writes that announce a change
   accept a `StageEvents` callback, invoked *last* inside the transaction with the
   outcome. Its events are INSERTed into the outbox before COMMIT. State and
   announcement are one atomic unit; a failure in either rolls back both.
2. **Mint envelopes before the write.** The callback is pure, so the event
   staged inside the transaction and the one dispatched/returned after it are
   the same event with the same `eventId`.
3. **Dispatch eagerly after commit** (`PgOutboxDispatcher`). Same latency as
   before and the same `InMemoryEventBus` behaviour every existing proof relies
   on. On the first transport failure it stops (a later event must not overtake
   an earlier one) and never throws: the event is durable and the relay owns it.
4. **Relay guarantees delivery** (`PgOutboxRelay`). Polls the producer's
   pending rows in `id` order, one active relay per producer cluster-wide
   (`pg_try_advisory_xact_lock`), records `attempts` / `last_error`, stops a batch
   at the first failure, skips rows younger than a grace window so it rarely
   races the fast path, and purges delivered rows after 7 days.
5. **At-least-once, stated plainly.** A crash between publish and stamp
   republishes. Consumers are idempotent by contract; that contract is now
   load-bearing and must stay so.

### Dead-letter containment (`events.dead-letter`)

1. **UNDECODABLE** payloads are parked immediately: bytes that are not a USRP
   event can never succeed.
2. **NonRetryableEventError** lets a handler declare an event permanently
   unprocessable and skip the retry budget.
3. **Everything else is presumed transient** and retried in-process with capped
   exponential backoff (default 6 attempts over ~15.5 s), heartbeating between
   attempts so the member is not evicted mid-retry.
4. **After the budget, park it** with the original key and bytes (byte-exact,
   same-partition replay) and headers naming the group, source
   topic/partition/offset, attempts, a truncated error and the event id.
5. **Dead-lettered or redelivered, never dropped.** If the dead-letter write
   fails, the bus rethrows and kafkajs redelivers.
6. **Replay is an operator act**: `pnpm --filter @usrp/shared-events dlq:replay
   --group <g> [--source-topic <t>] [--execute]`, dry run by default.

## Consequences

- A committed transition can no longer lose its event. Proven by
  `services/application-service/selfcheck/verify-outbox-slice.ts`, which
  reproduces the lost-CLEARED path (GREEN with the broker down, redelivery
  returns NO_CHANGE) and shows CLEARED still delivered, exactly once.
- A poison message costs one retry budget, not a partition. Proven by
  `packages/shared-events/selfcheck/verify-dead-letter.ts` (garbage, a
  persistently failing event and a non-retryable one all ahead of a valid event
  on one partition; the valid event is handled).
- **The front door now returns 201 when the broker is down.** That is the
  intended behaviour: the application is filed and its event is durable.
- **Ordering.** The relay preserves commit order per producer. The eager fast
  path can, in a failure window, publish a later transaction's event before the
  relay delivers an earlier one. The projections are order-independent and
  monotonic (proven in `verify-vetting-projection.ts` §7), which is what makes
  this acceptable. Any future consumer that is *not* order-independent must say
  so and be designed for it.
- **A sustained database outage dead-letters events** after ~15.5 s each,
  serially per partition. That is visible (`event_dead_lettered` at error
  level) and recoverable (replay). The alternative, blocking forever, is
  invisible and unrecoverable without code.
- **PII:** outbox payloads are exactly what Kafka already carries (opaque ids,
  keyed hashes, never a raw National ID). Delivered rows are purged after 7 days.
  The DPO should still confirm that window against ADR-015.

## Not done here (mechanical follow-up, same pattern)

Walk-in registration and on-site-vetting audit events now follow this pattern:
the officer-role application/history writes switch to the system role and
stage their events last in the same transaction, then the dispatcher provides
the post-commit fast path. `verify-walk-in-slice.ts` proves both successful
outbox rows and rollback of application, history, audit, and outbox on injected
staging failure.

The remaining dual writes in application-service (slot / notification /
physical-test / forensics projectors, officer transitions, self-withdrawal,
auto-withdrawal) and in every other producing service still commit-then-publish. Each converts the same way: add `stage?` to the
repository method, build events from the outcome with pre-minted envelopes,
swap `eventBus` for `PgOutboxDispatcher` in deps, start a relay in `main.ts`
with that service's producer name. Lift `pg-event-outbox.ts` into a shared
package when the second service adopts it, not before.

A consumer-side **processed-event ledger** (dedupe by `eventId` per group) is
the complement for consumers whose effects are *not* naturally idempotent.
The audit sink is the first candidate: at-least-once delivery can append a
duplicate audit row today.
