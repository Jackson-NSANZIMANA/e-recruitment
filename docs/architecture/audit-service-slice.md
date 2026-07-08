# audit-service — Immutable audit-trail sink (slice)

**Status:** Done · **Date:** 2026-07-08 · **Depends on:** ADR-001 (Kafka),
`0001` role model, the `audit_log` schema.

## Why this slice, now

Three services already emitted `AUDIT_ENTRY` onto `audit.immutable`
(identity-service, eligibility age gate, eligibility NESA gate) — but **nothing
consumed the topic**, so every audit event fell on the floor. Worse, the
`audit_log.audit_entries` table's own header *claimed* it was
"immutable ... Enforced at database role level (REVOKE UPDATE, DELETE)", yet
`0001_roles_grants_rls.sql` never mentioned `audit` at all: **the immutability
was a comment, not code**. Anything with table access could silently `UPDATE`
or `DELETE` the forensic record.

For a national-security recruitment system under **Law N° 058/2021**, an audit
trail that captures nothing and can be silently altered is worse than none — it
is a false assurance. This slice makes the claim true and gives the existing
producers a durable sink.

## What was built

### 1. Enforcement — `packages/shared-database/src/rls/0002_audit_immutability.sql`

Re-runnable, applied as `usrp_admin` alongside `0001`. **Belt and suspenders:**

- **Belt (role grants):** a new `usrp_audit_writer` NOLOGIN role, granted to
  `usrp_app`, with **`INSERT, SELECT` only** on `audit_log.audit_entries`.
  UPDATE/DELETE/TRUNCATE are never granted (and explicitly REVOKE'd to strip any
  inherited broad grant). Ordinary application paths physically cannot mutate
  history.
- **Suspenders (trigger):** grants do **not** bind the table owner or a
  superuser. A `BEFORE UPDATE OR DELETE` row-level trigger + a
  `BEFORE TRUNCATE` statement-level trigger both call `audit_log.reject_mutation()`,
  which `RAISE`s unconditionally. This refuses tampering for **every** role,
  owner and superuser included — the real immutability guarantee.

> **Deployment caveat (documented, not a defect):** the table owner *can*
> `ALTER TABLE ... DISABLE TRIGGER` (the self-check does exactly this to clean
> up). The trigger defeats every application path and all accidental tampering;
> defeating a determined superuser is a deployment concern — production must run
> the app as the non-owner, non-superuser `usrp_app` login (already the model)
> and guard admin/superuser credentials via HSM/KMS + break-glass procedure.

### 2. The service — `services/audit-service` (a new archetype: pure event sink)

Hexagonal, mirroring the identity-service template, but **consumer-first with no
business HTTP surface**:

- **Port** `AuditWriter.append(record): 'inserted' | 'duplicate'` — idempotent
  by contract.
- **Adapter** `PgAuditWriter` — `SET LOCAL ROLE usrp_audit_writer`, one
  `INSERT ... ON CONFLICT (kafka_event_id) DO NOTHING RETURNING id`. A returned
  row ⇒ `inserted`; none ⇒ `duplicate`. Never `DO UPDATE` — that would be a
  mutation of the immutable trail (and the trigger would reject it).
- **Mapper** `toAuditRecord(event)` — pure `AuditEvent` → `AuditRecord`; normalises
  optional envelope/event fields to explicit nulls.
- **Ingress** `startAuditEntryConsumer` — subscribes group `audit-service` to
  `audit.immutable`. A write failure **propagates** so the offset is not
  committed and the event is redelivered (losing a record is unacceptable;
  a redelivered duplicate is harmless).
- **`main.ts`** — env-selected bus (Kafka iff `KAFKA_BROKERS`), start consumer,
  serve `/health` + `/ready` (DB ping) via `shared-http` with `routes: []`,
  graceful shutdown. **The trail is written ONLY off the backbone, never by a
  synchronous caller** — no service can be tricked into forging an entry through
  an API; it can only emit an event, which is captured verbatim.

Config is the leanest in the platform: runtime + database only. The sink calls
no G2G agency and decrypts no PII, so it demands neither secret — minimal blast
radius.

### Idempotency & the metadata write

- **Idempotency key** = `kafka_event_id` (already `UNIQUE`). This is what makes
  at-least-once Kafka delivery safe.
- **postgres.js gotcha (found + fixed in this slice):** `sql.json(obj)` failed at
  runtime here ("string argument must be ... Received an instance of Object").
  The working idiom is `${JSON.stringify(obj)}::jsonb`. First code to write
  `audit_entries` via postgres.js, so this surfaced now.

## Proof — `selfcheck/verify-audit-slice.ts` (24 assertions, live Kafka + PG)

1. **Capture** — a published `AUDIT_ENTRY` becomes exactly one durable row;
   correlation/causation, action, agency, occurred_at all intact; DB sets
   recorded_at; metadata round-trips.
2. **Idempotency** — re-append of the same `eventId` returns `duplicate`, leaves
   exactly one row, and does **not** overwrite the original metadata.
3. **Immutability** — UPDATE, DELETE, and TRUNCATE are all rejected **as the
   table owner**; the row survives untampered; `information_schema` confirms the
   writer role has INSERT+SELECT and **not** UPDATE/DELETE.
4. **No PII** — no raw NID/name sentinel in the persisted row.

**End-to-end integration also proven live:** the running audit-service durably
recorded a real `AGE_ELIGIBILITY_PASSED` emitted by the eligibility
event-driven producer (`audit_entries` 0 → 1). Compiled run
(`node dist/main.js`) serves health/readiness and shuts down gracefully on
SIGTERM (exit 0).

```bash
# 0001 + 0002 applied as admin; tier1 PG + tier2 Kafka up
DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
KAFKA_BROKERS='localhost:29092' \
pnpm --filter @usrp/audit-service selfcheck
```

## Scope boundaries (deliberate)

- **No producer changes.** Columns the current producers don't populate
  (`performed_by_role`, `ip_address`, `user_agent`) are mapped to null.
- **entity_type enum divergence untouched.** The DB enum is a superset of the
  event union (`DOCUMENT`, `VENUE` exist only in the DB); pass-through is always
  valid. Reconciling the two enums is a shared-types concern for later.
- **No historical backfill.** Events emitted before this sink existed are gone;
  the trail is durable from here forward.

## Follow-ons

- Fold `0002` into the standard bootstrap alongside `0001` (docs/§13).
- Consider a periodic reconciliation/anchoring (e.g. hash-chaining rows) if
  tamper-*evidence* beyond tamper-*prevention* is ever required.
