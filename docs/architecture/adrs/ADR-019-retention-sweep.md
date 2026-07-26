# ADR-019 — Retention Sweep: Scheduled, Gated, Dry-Run-First Destruction

**Status:** Accepted (owner-signed 2026-07-26)
**Related:** ADR-015 (erasure — the mechanism this schedules), ADR-017 (auto-withdrawal — made the negative-terminal class real), ADR-018 (sessions/challenges — the hygiene class), `docs/compliance/retention-schedule.md`
**Legal frame:** Law N° 058/2021 — storage limitation. *Engineering position; DRAFT pending agency/DPO sign-off of the schedule.*

## Context

ADR-015 built the erasure mechanism but only the citizen-demand trigger.
Storage limitation is the controller's OWN duty: PII whose purpose has
lapsed must be destroyed without anyone asking. The retention schedule
existed with every period marked TBD, and nothing enforced any of it.
ADR-017 completed the terminal geometry (WITHDRAWN reachable), ADR-018
added two new personal-data tables (sessions were already personal data;
OTP challenges joined them) — the sweep's classes were finally all real.

## Decision (owner D7, 2026-07-26)

### Adopted periods — operational now, DRAFT for sign-off

| Class | Period | Mechanism |
|---|---|---|
| Never-applied identity | 12 months after registration | Gated tombstone |
| All-negative-terminal identity | 24 months after last application activity (appeal window) | Gated tombstone |
| Dead sessions + OTP challenges | expiry/termination + 30 days | Hard DELETE |
| Applications / history / audit | 7 y / 7 y / 10 y record horizons | **Never swept** — engine-immutable, PII-free after the subject's tombstone |

The periods live in exactly one place in code
(`identity-service/src/config.ts`, `RETENTION_*`) and are mirrored in the
retention schedule; changing one without the other is a review failure.

### Dry-run is the default; destruction demands the flag

`retention-sweep.ts` prints what the policy WOULD sweep (per-class UUIDs +
counts, cutoffs) and exits. Only `--execute` performs. A cron can run the
report daily and the execute on the owner's cadence; a human can always ask
"what would you take?" for free. Proven: the dry-run makes zero writes and
emits zero events.

### The sweep can never overreach — it reuses the citizen-demand gate

Candidates are DISCOVERED by retention SQL but DESTROYED through the same
`ErasureRepository` transaction as ADR-015: the terminal-only/accept-lock
gate is re-checked inside each erasure. A candidate whose state changed
between discovery and execution (a new application, an acceptance) is
**skipped and reported, never forced**. Active applicants, enlisted
citizens, and fresh registrations are structurally unsweepable — proven
with controls seeded next to the candidates.

### Distinct audit action

Every executed tombstone emits `RETENTION_ERASURE_EXECUTED`
(`performedBy: 'retention-sweep'`, `agency: 'SYSTEM'`, metadata naming the
class and policy). A retention erasure is the controller's own accountable
act — auditors must be able to tell it from a citizen-demanded
`ERASURE_EXECUTED` at a glance. Gate-skips emit no audit (they are not
refusals of a data-subject request); they appear in the run report.

## Proof (gate #33 — `verify-retention-sweep-slice.ts`)

Live, re-runnable, green ≥2×: backdated candidates (13-month never-applied,
25-month negative-terminal) + three controls (fresh, active, enlisted+locked)
+ dead/live session and challenge pairs. Dry-run reports exactly the
candidates, writes nothing; execute tombstones both (PII → 'ERASED', hash
rotated, deleted_at), purges only the dead hygiene rows, leaves every
control and live row intact, audits each tombstone with its class; a second
execute finds nothing.

## Consequences

- The compliance story closes its loop: collect → protect → erase on demand
  (ADR-015) → **destroy on schedule** (this). The last "mechanism not built"
  row in the retention schedule for data that exists today is done.
- The schedule's periods are now enforced fact, not aspiration — which
  makes the pending agency sign-off a review of running behavior.

## Follow-ons (explicitly out of scope, flagged)

1. **Scheduling itself** — the sweep is cron-able but nothing crons it;
   ops-tier concern (deferred with the rest of dim 7).
2. **Kafka topic retention config** (≤ 30 days, D7) — infra config not yet
   pinned in the compose/broker setup.
3. **MinIO document retention** — still blocked on the upload slice
   (ADR-015 follow-on; the schedule keeps its blocking note).
4. **Post-discharge erasure** of enlisted citizens — personnel-record
   domain, carried from ADR-015.
5. **DB backups** remain blocked on the per-citizen DEK upgrade (ADR-015
   D1 ordering constraint) — the sweep inherits that constraint: once
   backups exist, swept PII must be crypto-shredded there too.
