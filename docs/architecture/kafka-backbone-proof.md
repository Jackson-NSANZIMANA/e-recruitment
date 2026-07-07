# Kafka Event Backbone — Proven for Real (2026-07-08)

ADR-001 chose Apache Kafka (KRaft) as the event backbone, and `@usrp/shared-events`
provided a `KafkaEventBus`. But until now every proof used the `InMemoryEventBus` —
nothing had ever crossed a real broker. This slice proves the backbone end-to-end
against a live Kafka, and event-drives the first service reaction across it.

## What is now proven

1. **`KafkaEventBus` round-trip** (`packages/shared-events/selfcheck/verify-kafka-roundtrip.ts`):
   publish a `NIDA_VERIFICATION_COMPLETED` through the bus to a live broker, consume
   it back through a real consumer group on the routed topic (`vetting.nida`), and
   assert the event survives byte-for-byte with envelope (correlation/causation),
   topic routing, and partition key intact.
2. **Event-driven age eligibility** (`services/eligibility-service/selfcheck/verify-event-driven.ts`):
   publish `APPLICANT_SUBMITTED` → eligibility's Kafka consumer auto-runs the age
   gate → emits an `AUDIT_ENTRY` back onto `audit.immutable`, observed by an
   independent consumer. **No synchronous call** couples the trigger and the
   reaction — only the backbone. The `AUDIT_ENTRY`'s `correlationId` is preserved
   from the trigger and its `causationId` is the trigger's `eventId`: the causal
   chain is real and traceable.

`APPLICANT_SUBMITTED` (not `NIDA_VERIFICATION_COMPLETED`) is the correct trigger:
it carries the chosen `category`, which the age band requires. The use case still
guards that the identity is `VERIFIED` before evaluating.

## Four real infrastructure bugs this proof surfaced

The backbone had never actually worked. Proving it (rather than asserting it)
found and fixed four defects in `infrastructure/docker/docker-compose.tier2.yml`:

1. **Host-unreachable broker.** The broker advertised only `PLAINTEXT://kafka:9092`
   — the in-network name — so a process on the host (services run under `tsx`/`node`
   on the host in dev; so do the self-checks) could produce/consume metadata but
   never reach the broker. **Fix:** a second `EXTERNAL://localhost:29092` listener
   (published on `29092`), the standard Confluent dual-listener pattern.
2. **Missing `vetting.hec` topic.** `KAFKA_TOPICS.VETTING_HEC = 'vetting.hec'` exists
   in code, but the topic initializer never created it, and
   `KAFKA_AUTO_CREATE_TOPICS_ENABLE=false` — so any HEC event would fail to publish.
   **Fix:** added the topic to the initializer.
3. **The topic initializer created no topics at all.** Two compounding causes: the
   original used backslash line-continuations in a YAML block scalar (a trailing
   space after `\` silently breaks bash continuation), and — the real killer —
   Docker Compose interpolates `${...}` in `command`, blanking the shell's
   `${spec%%:*}` / `$topic` and erroring with *"invalid interpolation format"*.
   **Fix:** rewrote as a single-element list command (so the whole script is one
   `bash -c` argument) with `$$` escaping so shell variables reach bash.
4. **Consumer groups could never form.** On a single-broker cluster the internal
   `__consumer_offsets` topic defaults to replication factor 3 and thus can never
   be created, so the group coordinator is unavailable — **producers work, every
   consumer crashes** (`KafkaJSGroupCoordinatorNotFound`). This is invisible until
   you actually consume. **Fix:** `KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1`
   (plus transaction-state RF/ISR = 1, and `GROUP_INITIAL_REBALANCE_DELAY_MS=0`).

Each fix carries an in-file comment explaining *why*, so it cannot silently regress.

## Running the proofs

Bring up tier2 Kafka (host listener on `:29092`) and Tier-1 Postgres, then:

```bash
# 1. backbone round-trip
KAFKA_BROKERS=localhost:29092 pnpm --filter @usrp/shared-events selfcheck:kafka

# 2. event-driven age eligibility (also needs Postgres + PII key)
DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
KAFKA_BROKERS='localhost:29092' \
pnpm --filter @usrp/eligibility-service selfcheck:events
```

## Service wiring

`eligibility-service/main.ts` starts the `applicant.submitted` consumer only when
`KAFKA_BROKERS` is set (the in-memory bus has no cross-process delivery). Consumer
group id is `eligibility-service`. The same service still exposes the synchronous
`POST /v1/eligibility/age-check` for direct/testing use — event-driven and
request/response are two ingress adapters over one hexagonal core.

## Deferred
- Consumer error handling / retry / dead-letter semantics (at-least-once today;
  the age gate is idempotent in effect, so reprocessing is safe).
- Wire identity-service to publish over real Kafka in its own `main.ts` run (the
  bus is already environment-selected; only an integration run remains).
- Schema Registry (tier2 includes it) for wire-schema governance.
