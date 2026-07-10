# Pipeline convergence fix — the "known flake" was a real consumer-group defect

**2026-07-10.** For several sessions `verify-pipeline-e2e` was documented as a
"known single-broker flake" and the gate ran at 16/17 (or 15/16), with the
full-chain proof treated as untrustworthy. That framing was wrong. The proof was
red because it was catching a **genuine production defect** in application-service's
event wiring. Fixing it made the gate **17/17 green, deterministically**
(10/10 consecutive runs, ~14s each, down from a 0/4 timeout storm).

## The defect

application-service has two projection consumers on one `KafkaEventBus`:

- `startVettingResultConsumer` → topics `vetting.{age,nesa,hec,rib}`
- `startSlotAssignedConsumer` → topic `slot.assigned`

Both subscribed with the **same** `groupId` (`application-service`), but to
**different topic sets**. In Kafka, all members of a consumer group must agree on
the subscription; two members with divergent subscriptions cannot reach a stable
assignment, so the group **rebalances perpetually**. `main.ts` starts both
consumers on one bus in the same group — so this ships in production, not just in
the test.

It stayed hidden because every *isolated* proof (`verify-vetting-projection`,
`verify-slot-assignment`) runs only **one** of the two consumers, so the group has
a single consistent member and is stable. Only the **full pipeline** runs both
together — which is exactly when it broke, the moment the slot consumer was added
in the slot-assignment slice (the full-chain proof passed 13/13 before that, with
3 services / fewer groups).

The comment on the slot consumer even rationalised the shared group as "one owner
of application state" — conflating *service* ownership with *consumer-group*
identity. They are orthogonal: a service may write the same rows from any number
of groups. The shared group also bought nothing — `slot.assigned` and `vetting.*`
are different topics (different partitions), so it never provided cross-topic
ordering.

## Diagnosis (evidence, not assertion)

Instrumented reproduction (`KAFKAJS_LOG_LEVEL=INFO`), 4 runs: **0/4 passed, an
identical 25 rebalances / 7 joins each run**, with every heartbeat-rebalance error
scoped to `clientId: application-service`. Deterministic churn concentrated on the
one group with two divergent-subscription members — not the variable, broad storm
a true single-broker contention flake would produce. Eligibility, which correctly
uses **two distinct groups** (`eligibility-service` + `eligibility-academic`),
showed no churn.

## The fix

Two parts:

1. **Root cause (production correctness):** the slot projection gets its **own**
   consumer group, `application-service-slot`
   (`APPLICATION_SLOT_PROJECTION_GROUP`), distinct from the vetting group. Each
   group now has a single member with a consistent subscription → stable, no
   rebalance loop. This is the correct Kafka design and mirrors eligibility.
   Fixes both `main.ts` (production) and the e2e.

2. **Test correctness:** with the pipeline now converging in ~14s, `DOCUMENT_REVIEW_GREEN`
   is a **transient waypoint** — scheduling auto-advances it to `SLOT_ASSIGNED`
   within milliseconds. Asserting live `status == DOCUMENT_REVIEW_GREEN` was
   therefore itself racy. The proof now asserts GREEN was **reached** via the
   append-only, monotonic status **history** (`awaitReached`), which cannot miss a
   transient waypoint, then asserts the resting `SLOT_ASSIGNED` separately.

## Verification

- **After fix:** total kafka rebalances in a run dropped from 25 → **0**.
- **Stress:** `verify-pipeline-e2e` **10/10** consecutive green, ~14s each.
- **Full gate:** `run-selfchecks.sh` → **17/17 green** (`ALL PROOFS GREEN`).

## Consequence

The `pipeline-flake hardening` seam is **closed** — and it was never really flake
hardening; it was a latent correctness bug. Any future post-eligibility stage that
adds another projection consumer to application-service must give it **its own
consumer group** (one group = one consistent subscription), never share an
existing one.
