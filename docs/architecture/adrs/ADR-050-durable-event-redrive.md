# ADR-050 — Durable event re-drive: a schedule for dead letters

**Status:** Accepted · 2026-11-01 (defect-closure session D0) · closes evaluation 2026-10-29 defect **D2**
**Deciders:** platform owner (decisions in §2) · engineering for §3
**Relates to:** ADR-025 dead-letter containment, ADR-006 single writer, ADR-011 late-verdict holds, ADR-048 Irembo clearance, ADR-051 vetting-hold resolution, ADR-042 observability (S11a)
**Migration:** `rls/0043_event_redrive_ledger.sql` (number provisional — renumber at rebase)

## 1. Context

ADR-025 gave every consumed message an error boundary and parks what cannot be handled on `events.dead-letter`. That was the right fix for a partition hostage. It left the other half unowned:

- **The retry budget is a window, not a schedule.** `DEFAULT_DEAD_LETTER_POLICY` is six attempts in ~15.5 s. An upstream outage longer than that is indistinguishable, to the platform, from a permanent failure.
- **Nothing reads the graveyard.** `scripts/replay-dead-letters.ts` is an operator tool: dry-run by default, no per-letter state, no backoff, no cap. Running it after a one-hour outage re-publishes **every** letter of a group, including letters already succeeded, with no notion of "already retried".
- **The consequence is a stuck citizen, not a lost event.** The event is durable; the *state* is not. A clearance certificate whose Irembo lookup met a 429 at 14:02 sits at `CRIMINAL_CLEARANCE` with a `PENDING / REGISTRY_UNAVAILABLE` verification row and a checklist that says "we are verifying" — forever. Measured on 2026-10-29: **D2**.

This is one gap, not one defect. It applies identically to the RIB-by-hash vetting gate, the Irembo certificate flow, and the NESA/HEC eligibility calls.

## 2. Owner decisions (2026-11-01)

| Decision | Taken |
|---|---|
| Automatic re-drive, not operator-only | **Automatic.** An outage must end in a result without a human being awake. |
| Attempt budget | 6 attempts over ~10 h (1 m, 5 m, 15 m, 1 h, 3 h, 6 h), configurable; the sandbox profile compresses the intervals to seconds. |
| After the cap | **Park** on `events.dead-letter-parked` with an audit record, and hand the case to the human path (ADR-051). Never silently retry forever. |
| Ownership of the parked signal | Emitted as an `AUDIT_ENTRY`, so S11a alerts on an existing stream instead of a new one. |

## 3. Decision

### 3.1 One spine, in one process

`services/event-redrive-service` — the 13th process, no business routes (`/health`, `/ready`, `/version` only) — hosts a `DlqRedriver` from `@usrp/shared-events`.

The service owns no domain state and makes no business decision. It reads letters, decides when to knock again, and republishes bytes.

### 3.2 Classification is pure and total

| Letter reason | Action | Why |
|---|---|---|
| `HANDLER_FAILED` | re-drive on the backoff schedule | the ADR-025 contract says this class is *presumed transient* |
| `NON_RETRYABLE` | **never** re-driven | the handler already decided it can never process it |
| `UNDECODABLE` | **never** re-driven | bytes that failed to decode will fail again; only a serializer change makes them decodable |

`decideRedrive()` is a pure function over `(reason, attempts, consecutiveFailuresForGroup)`; it is exhaustively unit-tested with no I/O, so the policy can be argued about in a test file rather than in production.

### 3.3 Durable per-letter state is the schedule

`public_core.event_redrive_ledger` (`rls/0043`):

| Column | Meaning |
|---|---|
| `source_topic`, `source_partition`, `source_offset`, `group_id` | the letter's identity; **UNIQUE** — one row per letter, so a restart or a second instance is idempotent |
| `attempts` | re-drives performed so far |
| `first_seen_at`, `next_attempt_at` | the schedule |
| `state` | `RETRYING` \| `PARKED` |
| `last_error_code`, `parked_reason` | closed codes only |

Kafka offsets are a cursor; they cannot schedule. This table is the scheduler. It is the same durable-claim idiom the platform already uses for stalled clearances (`ReannounceStalledClearancesService`) and slot reservations.

Single-instance safety: a Postgres advisory lock. Two workers started by mistake do not double-publish.

### 3.4 Re-drive is byte-exact and provenance-marked

The original key and value are re-published unchanged to the original topic, with `x-usrp-replayed-from-dlq: true` (the header the operator tool already writes). Consumers are idempotent by contract — projections answer `NO_CHANGE` on redelivery — **and that is the load-bearing assumption of this ADR**: a re-drive may not change state twice, and may not regress a status (ADR-006/ADR-011 monotonicity). The selfcheck proves both.

### 3.5 The circuit breaker exists to protect the platform from us

If the same `(group_id, source_topic)` fails `K` consecutive re-drives, the worker **stops re-driving that group**, parks its letters with `REPEATED_FAILURE`, and logs one `ERROR`. The operator tool's own warning — *"fix the cause first; replaying into the same bug just parks it again"* — becomes code rather than advice. Without it, a deterministically broken handler turns a 4-core deployment into a retry furnace.

A publish budget per tick bounds total re-drives regardless of how many letters exist.

### 3.6 The operator tool stays

`replay-dead-letters.ts` remains the manual last resort: it is the only way to re-drive `UNDECODABLE` letters after a serializer fix, and the only escape when the ledger itself must be overridden. This ADR adds automation; it removes no control.

## 4. Rejected alternatives

| Alternative | Why not |
|---|---|
| **Cron the existing operator script** | Stateless: no dedup, no backoff, no cap. It re-publishes already-succeeded letters and re-drives a permanently broken event forever. |
| **Raise `maxHandlerAttempts` (e.g. 20)** | Holds a partition hostage for minutes and *still* ends in the same graveyard. The window is not the problem. |
| **Host the re-driver in application-service** | A domain service would gain authority over other services' failures, and its consumer group would be the wrong owner of a platform concern. |
| **A per-service retry table inside background-vetting-service** | Redundant: re-driving the parked *event* re-runs the check by construction (`CLEARANCE_CERTIFICATE_SUBMITTED` is byte-exact and the use case is idempotent). It also fixes only one of three affected lanes. |
| **Retry inside the HTTP/gateway layer** | The edge already refuses to retry writes (`retryOnG2G: false`), deliberately. Retrying a write in transport is how duplicate side effects happen. |

## 5. Consequences

- An upstream outage of hours now ends in a result, with no human awake. An outage that outlives the cap ends in a **parked** state that the officer queue can act on (ADR-051) — not in "verifying".
- One more process to boot, supervise and monitor: added to `sandbox:full`, both compose tiers, and the health sweep; it holds a DB connection, so it belongs in the readiness picture only once its consumer is subscribed.
- A new topic (`events.dead-letter-parked`) must be pre-created: broker auto-create is disabled by design.
- The ledger grows one row per dead letter forever. It is small (no payload), but it needs a retention rule: `PARKED` rows are kept (they are the evidence of a failed recovery), `RETRYING` rows past their schedule are kept; nothing is deleted automatically in phase 0. Recorded as follow-up.

## 6. Not decided here

- Whether a parked case should raise a citizen-visible notice directly (S10a owns notices; this ADR stops at "the officer queue can see and resolve it").
- Retention and archival of the ledger and the parked topic.
- Re-drive of a *different* group than the one that failed (cross-group replay remains operator-only).
