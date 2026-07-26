# ADR-015 — Right to Erasure and Retention: Tombstone Overwrite Behind a Terminal-Only Gate

**Status:** Accepted (owner-signed 2026-07-26)
**Related:** ADR-002 (schema isolation), ADR-014 (accept-lock), rls/0002/0007 (immutability), rls/0005 (G2G lookup hash), rls/0014 (erasure freeze)
**Legal frame:** Rwanda Law N° 058/2021 (protection of personal data and privacy) — right to erasure, storage limitation, controller accountability. *The legal interpretations in this ADR are engineering positions; they are **DRAFT pending review by the owner, the agencies' legal officers, and where required the supervisory authority (NCSA/DPO)*.*

## Context

USRP is a controller of highly sensitive citizen data. The PII surface is
deliberately tiny — one table:

- **`public_core.applicant_identities`** — the only direct-PII store. Five
  `encrypted_*` columns (pgcrypto `pgp_sym_encrypt` under one platform key,
  set transaction-locally), plus linkage/identifier columns
  (`national_id_hash`, `phone_number_hash`, `biometric_session_id`,
  `nida_verification_request_id`, confidence/timestamps).
- **`public_core.applicant_sessions`** — personal data (session token, IP
  address, user agent). Zero TypeScript writers today.
- Everything else — ops-schema `applications`, `application_status_history`,
  `physical_test_scores`, `audit_log.audit_entries` — carries only opaque
  UUIDs, statuses, and scores. No name, no NID, no hash of either.

Until this slice the platform could *collect and protect* PII but could not
*destroy* it. The right to erasure had no mechanism, no gate, no audit — and
`docs/compliance/` was empty. This was the top compliance finding on the
verified scorecard.

Two questions had to be answered by the accountable owner, not the engineer:

1. **What does "erase" mean mechanically** in a system whose PII is
   encrypted under a single platform key?
2. **When may the platform lawfully refuse** a citizen's erasure demand,
   given the agencies' own legal obligations around recruitment records?

## Decision

### D1 — Tombstone-overwrite erasure (owner, 2026-07-26)

Erasure is executed by **overwriting the PII in place, in one UPDATE**:

- the five `encrypted_*` ciphertexts → the literal `'ERASED'` (the original
  pgcrypto envelopes cease to exist);
- `encrypted_nida_lookup_hash` → NULL (the G2G re-lookup capability is
  destroyed with the identity);
- `national_id_hash` → rotated to `'e' + 63 random hex chars` — it must stay
  UNIQUE NOT NULL, but the rotated value is unlinkable (no NID hashes to it)
  and visibly marks the tombstone;
- `phone_number_hash`, `biometric_*`, `nida_*` identifier columns → NULL /
  false;
- `deleted_at` → `now()` — **the erasure marker** (no enum change;
  `identity_verification_status` deliberately gains no ERASED value);
- the citizen's `applicant_sessions` rows are hard-DELETEd (token, IP,
  user-agent are personal data).

**Why this is genuine destruction today:** this tier runs **no backups and no
replicas**. The live cluster is the only copy; overwriting the ciphertext
destroys the last instance of it. WAL retention is the residual (bounded,
rotates out); this is recorded as accepted residual risk below.

**Mandatory upgrade path (owner-accepted condition of D1):** before ANY
backup or replication infrastructure lands, PII encryption MUST move to
**per-citizen data-encryption-keys (DEK)** so that erasure becomes
crypto-shredding (destroy the citizen's DEK; every backup copy becomes
ciphertext without a key). Tombstone-overwrite is only sound while the live
row is the only copy. This ordering constraint is a hard prerequisite in the
deployment plan, not a nice-to-have.

### D2 — Erasure gate: terminal-only, not enlisted (owner, 2026-07-26)

Erasure is **allowed iff**:

- the citizen is **not accept-locked** (ADR-014 — an accepted citizen is
  enlisted personnel; their identity record is now a service record with a
  retention obligation), **and**
- **every** application of the citizen, across all three ops schemas, is in a
  negative-terminal state: `REJECTED`, `WITHDRAWN`, or `WALK_IN_REJECTED`.

Zero applications ⇒ allowed (a citizen who only verified identity and never
applied can always be erased). Any in-flight application ⇒ **truthful
refusal** with a legal-basis code naming the blocking agency and status —
processing is ongoing at the citizen's own initiative; the lawful route is
to withdraw first (withdrawal itself is a flagged follow-on; the enum value
exists with no writer yet). The gate is **fail-closed**: any state it cannot
classify refuses.

### What survives erasure — and why

`audit_log.audit_entries` and the ops `application_status_history` /
`applications` rows are **retained**. Basis: they are (a) engine-immutable by
design (rls/0002/0007 — REVOKE + unconditional RAISE triggers), and (b)
**PII-free** — applicant UUID, statuses, scores, officer ids. After the
tombstone lands, that UUID resolves to nothing: no name, no NID, no linkable
hash. What remains is the agencies' legal-obligation processing record
(evidence of a lawful recruitment process), which Law N° 058/2021 permits to
survive an erasure demand. The erasure act itself is *added* to that trail:

- **every attempt is audited** — `ERASURE_EXECUTED` and `ERASURE_REFUSED`
  alike (a refusal and its ground are accountable acts of the controller),
  with PII-free metadata (outcome code, refusal ground, agency label);
- unlike officer-transition audits, which record state changes only.

### Irreversibility at the engine — rls/0014

A migration in the platform's immutability doctrine: an unconditional
BEFORE UPDATE trigger on `applicant_identities` refuses **any** UPDATE of a
row whose `deleted_at` is set — binding `usrp_system_service`, the owner,
and mistaken future app code alike. Erasure cannot be undone, and a tombstone
cannot be repopulated, from SQL. (Residual: superuser `DISABLE TRIGGER` /
`session_replication_role = replica` — the same doctrine-wide residual as
rls/0002/0007, used deliberately by selfcheck teardowns.) rls/0014 also
carries the **first grants ever** on `applicant_sessions`
(`SELECT, DELETE → usrp_system_service`), scoped to exactly what erasure
needs; RLS on that table is deferred until it gains real writers.

### Execution model

`POST /v1/identities/erasure` (identity-service) — **officer-only** (401
unauthenticated, 403 system/applicant): erasure is an accountable human act
executed on a citizen's demand, never an automated one. The body carries the
opaque applicant UUID only; raw NIDs are never accepted on this route. Any
agency's officer may execute — the gate, not the caller's affiliation,
decides lawfulness. The whole erasure is one transaction as
`usrp_system_service`, serialized on the identity row via `FOR UPDATE` — the
**same row lock the accept-lock uses**, so an erasure racing a concurrent
accept resolves correctly (winner stamps the lock → erasure sees it and
refuses; or erasure wins → the accept's identity row is gone from its RLS
view). Idempotent: re-erasing a tombstone returns `ALREADY_ERASED` (200)
without touching the row.

## Alternatives considered

- **Per-citizen DEK crypto-shredding now** — the strictly stronger model,
  rejected *for now*: it re-keys the entire PII read/write path for zero
  additional destruction guarantee while no backups exist. Adopted instead
  as the mandatory precondition to backups (see D1).
- **Hard DELETE of the identity row** — rejected: ops applications FK the
  row (processing record would dangle or cascade away, violating the
  agencies' retention obligation), and a vanished row cannot testify that
  erasure *happened*.
- **`ERASED` enum value on `identity_verification_status`** — rejected:
  enum surgery on a live type for what `deleted_at IS NOT NULL` already
  states; every existing reader (`findIdByNationalIdHash` filters
  `deleted_at IS NULL` since the first slice) is already correct.
- **Erasure allowed for enlisted citizens after discharge** — out of scope;
  requires a discharge signal that does not exist. Flagged follow-on.

## Consequences

- The platform can now truthfully answer a Law N° 058/2021 erasure demand:
  execute it, or refuse it with a named, audited legal ground.
- The PII lifecycle is closed end-to-end: collect (verify) → protect
  (encrypt + RLS) → destroy (erase) — each leg engine-enforced and proven
  live by gate #29 (`verify-erasure-slice.ts`).
- A tombstoned citizen can re-register later via the normal verify road: the
  rotated hash no longer collides with their real NID hash, so a fresh
  identity row is created. This is correct — erasure is not a ban.
- Accepted residual risks (owner-visible): WAL retention window; superuser
  trigger bypass; single platform PII key until the DEK upgrade.

## Flagged follow-ons (owner backlog)

1. **Per-citizen DEK before backups** — hard ordering constraint (D1).
2. **MinIO object erasure** — `document_records` stores only object
   pointers today and no upload path exists; when uploads land, erasure MUST
   extend to deleting the citizen's stored objects (and the pointer rows'
   immutability policy must be decided then).
3. **Citizen-initiated withdrawal** — first writer for `WITHDRAWN`; the
   lawful self-service route out of the "active application" refusal.
4. **Retention sweep** — scheduled erasure of stale PENDING identities and
   post-campaign data per the retention schedule (docs/compliance) once the
   owner/agencies sign retention periods.
5. **DPO role & citizen-facing request intake** — today erasure is executed
   by an officer on demand; a formal request-tracking workflow (deadline
   clocks, citizen notification) is a product slice of its own.
6. **Erasure after discharge** of formerly enlisted personnel — needs a
   discharge signal from agency HR systems.
