# ADR-021 — Contact Capture + Real Invitation Delivery

**Status:** Accepted (owner-signed 2026-07-27, decisions D13a–D13d)
**Related:** ADR-018 (applicant auth — the capture moment + follow-ons #3/#5 this closes), ADR-009 (signed slot invitation — "transport-only until a notification channel exists"; the channel now exists), ADR-015/ADR-019 (the two erasure roads this integrates with), ADR-017 #1 / ADR-020 #5 (withdrawal + erasure-decision notices — unblocked by this), ADR-020 (records the drizzle-drift warning this ADR settles), `docs/compliance/dpia.md`
**Legal frame:** Law N° 058/2021 — storage of a deliverable contact. *Engineering position; DPIA updates remain DRAFT pending owner/agency sign-off.*

## Context

No citizen contact was stored anywhere: ADR-018 stamped only
`phone_number_hash` (a lookup digest — verifiable, not deliverable), so
notification-service's resolver returned null for every applicant and every
slot invitation was recorded `PENDING_NO_CONTACT`. Nothing the platform
"sent" ever went anywhere, and the flagged notices of ADR-017 (withdrawal)
and ADR-020 (erasure decisions) had no channel to ride.

The raw phone already existed in memory at exactly one moment we control:
the verifyOtp best-effort stamp block re-resolves the citizen against NIDA
and holds `registeredPhoneNumber` for the length of one call.

## Decisions (owner D13, 2026-07-27)

### D13a — SMS-only, one column

`public_core.applicant_identities.encrypted_phone_number` (nullable text,
pgcrypto ciphertext; **rls/0018**, hand-SQL per the 0005 precedent). No
email: NIDA carries none and no capture UI exists — `ResolvedContact`
narrows to `'SMS'`; an EMAIL channel returns later with its own port and
resolver change. No new grants: the column inherits the system role's
table grants (0001); the 0014 freeze covers it automatically (row-level,
deleted_at-driven).

### D13b — Necessity basis, no consent flow

Storing the NIDA-registered phone is framed as necessary for statutory
notification within the recruitment process the citizen initiated (they
already receive OTP SMS on this number; storage extends the purpose to
process notices). Documented in the DPIA data-inventory row + purpose
line; **agency legal sign-off remains pending as for the whole DPIA**. No
consent step is added to the OTP flow.

### D13c — Port + LogChannel only, and the two SMS ports unify NOW

New zero-dependency **`@usrp/shared-sms`**: `OutboundSms`,
`SmsDeliveryOutcome = 'ACCEPTED' | 'FAILED'`, `SmsChannel`, and the dev
`LogSmsChannel`. It replaces identity-service's `SmsChannel` ('SENT') and
notification-service's `NotificationChannel` ('DELIVERED') — both retired
literals overclaimed; a transport can only know *accepted-by-gateway*.
Consequences held deliberately:

- **Event/DB literals unchanged.** `deliver-invitation` maps
  `ACCEPTED → 'DELIVERED'` at one commented site; the
  `NOTIFICATION_DELIVERED` event and `sms_notification_status` keep their
  existing values (that literal has always meant "transport accepted").
  A future delivery-receipt slice cuts at exactly that mapping.
- **requestOtp still discards the outcome** — deliberate: a FAILED send
  must not break the uniform `CHALLENGED` no-enumeration response.
- **No provider code.** No telecom contract exists (compliance boundary);
  an adapter that cannot be proven against anything real would violate
  prove-don't-assert. The real MTN/Airtel adapter lands once, in
  shared-sms, when a contract (or sandbox credentials) exists. It must
  also settle destination normalization (the NIDA mock's phones are not
  E.164; LogSmsChannel doesn't care, a gateway will).

### D13d — Migration = hand-SQL rls/0018; drizzle `generate` is OFF-LIMITS

The drift audit (this slice, scratch `drizzle-kit generate`, reverted)
measured the 0000 snapshot as stale by **26 statements across 6 hand
migrations**: `field_devices` (0009) and `officer_accounts` (0010) as full
CREATE TABLEs, ADJUDICATION_REVIEW enum ALTERs ×3 (0011), age columns ×3
schemas (0006), RNP cert columns (0012), `encrypted_nida_lookup_hash`
(0005). Because bootstrap runs drizzle 0000 *before* the idempotent rls/
files, a naively generated catch-up (bare CREATE TABLE) would no-op cold
DBs but **collide on every warm DB** — the 0000 collision lesson inverted.
Standing decision: **rls/ hand-SQL is the schema-evolution system of
record; running `drizzle-kit generate` is prohibited until the snapshot is
reconciled as its own deliberate slice** (hand-edited idempotent catch-up,
proven warm AND cold). The schema .ts files remain the readable mirror.

> **Disposition (owner D15, 2026-07-31): the prohibition is RETIRED; the
> first half stands.** Re-measured after rls/0018 the drift was **27
> statements across 7 files** (the +1 being `encrypted_phone_number` itself,
> uncounted above). It was reconciled **snapshot-only** — `meta/0000_snapshot.json`
> rewritten to describe the post-bootstrap state (0000 + rls/), with **no new
> SQL migration** and `_journal.json` untouched, so no database warm or cold
> executes anything new. No catch-up migration was authored: a drizzle-only
> database has no grants and no RLS, so it is never valid, and duplicating
> DDL that rls/ already owns would have bought nothing. `rls/` hand-SQL
> remains the system of record. Enforcement moved from memory to the gate —
> `packages/shared-database/selfcheck/verify-schema-drift.ts` fails on any
> divergence between the .ts mirror, the snapshot and the live DB. Procedure:
> `docs/architecture/schema-evolution.md`.

## Mechanics

- **Capture** — the verifyOtp stamp block passes the raw phone as a third
  argument to `stampPhoneVerified`; the repository (now constructed with
  the pgcrypto key, exactly like `PgIdentityRepository`) encrypts it
  in-transaction alongside the HMAC + `phone_verified_at`. Best-effort
  semantics unchanged (a NIDA hiccup never fails an earned login);
  re-stamping overwrites, absorbing NIDA phone changes. The raw phone
  crosses the port in exactly one method, is never logged, never returned,
  never on the bus (proof-asserted).
- **Resolution** — `PgContactResolver` (notification-service's first DB
  adapter): `SET LOCAL ROLE usrp_system_service` → transaction-local key →
  `pgp_sym_decrypt` WHERE `deleted_at IS NULL AND encrypted_phone_number
  IS NOT NULL`. Null strictly means nothing-deliverable (unknown /
  contact-less / erased); genuine faults **throw** so a bad key can never
  masquerade as `PENDING_NO_CONTACT`. This is the repo's first production
  decrypt path. Config gains the narrow
  `security: { encryptionKey }` (PII_ENCRYPTION_KEY only — eligibility
  precedent; new required env var for the service).
- **Composition** — `createNotificationService(config, bus, {resolver,
  sms})`: adapters are caller-supplied (identity pattern); main.ts wires
  `PgContactResolver` + `LogSmsChannel`; `NoStoredContactResolver` is
  deleted (its header promised exactly this replacement).
- **Erasure** — `encrypted_phone_number = NULL` joins the tombstone
  overwrite. One repository covers BOTH destruction roads: citizen-demand
  erasure (ADR-015) and the retention sweep (ADR-019) share the
  `ErasureRepository`, so the sweep needed no change. Retention: the
  contact is lifecycle-tied to the identity row's PII (schedule row
  added).
- **No application-service change** — the projection already recorded
  `deliveryStatus` verbatim and handles DELIVERED / PENDING_NO_CONTACT
  symmetrically. It simply records DELIVERED now.

## Proof

Gate unit 36, `verify-contact-delivery-slice.ts` (fixtures ad210000, zero
HTTP servers, zero Kafka — in-proc factories): real OTP login against the
NIDA mock → ciphertext present, decrypts to the mock's phone, not
plaintext → PgContactResolver resolves → DeliverInvitationService sends
for real (destination seen by the channel, QR in body) → projection
advances to PHYSICAL_TEST_SCHEDULED with `sms_notification_status =
'DELIVERED'` (asserted for the first time anywhere) → erasure destroys the
contact → resolver null → fresh delivery honestly records
PENDING_NO_CONTACT with nothing sent → no bus event carries the phone,
the OTP code, or the citizen's NID hash. Green twice. Existing proofs
extended: applicant-auth (capture + ciphertext-not-plaintext), erasure
(contact NULLed), notification (§6 resolver semantics incl. erased-row
null).

## Follow-ons (explicitly out of scope, flagged)

1. **Real MTN/Airtel adapter** in shared-sms (blocked on telecom
   contract): credentials config, E.164 normalization, failure taxonomy,
   and — if receipts are contracted — a true DELIVERED literal end-to-end.
2. **Drizzle snapshot reconciliation** as its own slice (per D13d).
3. **Withdrawal + erasure-decision notices** (ADR-017 #1, ADR-020 #5) —
   now buildable on this channel.
4. **Delivery retry/queue** — redelivery still re-sends (dedupe lives in
   the downstream projection only); acceptable for dev-tier LogChannel,
   revisit with a real provider.
5. **Contact-staleness handling** — the stored phone refreshes only on
   login; a citizen who changes their NIDA phone and never logs in again
   keeps the old stored value until then.
