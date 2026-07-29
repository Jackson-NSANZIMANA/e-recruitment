# ADR-022 — Citizen process notices: withdrawal + erasure decisions

**Status:** Accepted (owner-signed 2026-07-27, decisions D14a–D14c)
**Related:** ADR-017 #2 (withdrawal notice — this closes it), ADR-020 #5 (erasure-decision notices — this closes it), ADR-021 (the contact channel + PII discipline these ride on), ADR-015 (the erasure transaction the execution notice must beat), ADR-006 (single writer — why notices are audit-only)

## Context

ADR-021 gave the platform a deliverable contact (`encrypted_phone_number`,
`PgContactResolver`, `@usrp/shared-sms`) and immediately flagged the two
notices it unblocked: telling a citizen their other applications were
retired when one agency accepted them (ADR-017 #2), and telling a citizen
their erasure request was decided (ADR-020 #5). Neither fact reached the
citizen: the withdrawal existed only as DB rows + audit entries, and the
erasure decision only in the intake store behind an authenticated portal
the erased citizen can no longer even log in to.

Two structural problems shaped the design:

1. **No carrier for the withdrawal fact.** The ADR-017 projector wrote
   rows and audits but emitted no consumable event. (Audit is a sink, not
   an integration channel — audit-service is its only consumer, by design.)
2. **The execution-notice paradox.** Erasure destroys
   `encrypted_phone_number` in the same transaction that constitutes the
   decision — after commit, no service can ever resolve the destination
   for "your erasure was executed."

## Decisions (owner D14, 2026-07-27)

### D14b — One summary event per acceptance carries the withdrawal fact

New PII-free `APPLICATION_WITHDRAWN` event (topic `application.withdrawn`),
emitted by the auto-withdrawal projector ONLY when it genuinely retired
something, carrying `applicantId`, the winner
(`acceptedApplicationId`/`acceptedByAgency`) and the retired
`{applicationId, agency}` list. Per-CITIZEN granularity: one acceptance →
one SMS, not one per retired application. Idempotent acceptance
redelivery → empty sweep → no event → no duplicate notice. Rejected
alternatives: per-application events (N near-identical SMSes, stateless
aggregation impossible); notification-service consuming
`application.accepted` and querying application state (races the
projector, couples notification into another service's data).

notification-service consumes it in its own group
(`notification-service-withdrawal`), resolves via the ADR-021 resolver,
sends via the one `SmsChannel`, and records a `WITHDRAWAL_NOTICE_NOTIFIED`
audit entry with the truthful `deliveryStatus`
(DELIVERED / PENDING_NO_CONTACT / FAILED).

**Notices are audit-only — deliberately NO `NOTIFICATION_DELIVERED`.**
That event exists to advance application state
(SLOT_ASSIGNED → PHYSICAL_TEST_SCHEDULED); a notice must never touch the
lifecycle, so the audit trail is its durable record.

Voluntary self-withdrawal (ADR-020) emits nothing: the citizen performed
that act in-session and sees its outcome directly.

### D14a — Execution notice: resolve BEFORE the tombstone, send after commit

`PgErasureRepository.eraseIdentity` decrypts the stored contact INSIDE the
erasure transaction, before the tombstone UPDATE — the existing
`FOR UPDATE` on the identity row makes read-then-overwrite atomic. The
value returns memory-only on the `ERASED` outcome (never logged, never
persisted, never on an event — the ADR-021 discipline), and the service
sends AFTER commit: a rolled-back erasure must never produce a sent
notice, and a channel fault must never mask an erasure that already
happened. Best-effort, mirroring the `markExecuted` pattern; the send
outcome is recorded truthfully in its own `ERASURE_DECISION_NOTIFIED`
audit entry. `ALREADY_ERASED` and refusals send nothing.

The repository takes the pgcrypto key as an OPTIONAL constructor argument:
the retention sweep constructs it without one — retention-expiry erasures
(ADR-019) notify nobody. That is a deliberate scope line, not an
oversight: a retention notice is a different legal act with its own
wording obligations (follow-on #4).

### D14c — Decline notice is a fixed body; the ground stays in the portal

The decline notice (contact resolved in the decline transaction — the
citizen still exists) says only that the request was declined and where
the recorded ground can be read. The officer's free-text ground may carry
case detail, and SMS is an unauthenticated surface read by whoever holds
the handset. Both erasure notice bodies are parameterless fixed strings —
PII-free by construction. The executed body does not reference the portal:
the erased citizen can no longer log in.

### Who sends what (service boundaries)

- **Withdrawal notice → notification-service** (event-driven): the fact is
  cross-schema application state; its owner emits, the notifier consumes.
- **Erasure notices → identity-service in-process**: the execution notice
  CANNOT leave the service (the contact dies in the same transaction; an
  event would either arrive too late or carry PII), and splitting decline
  from execution across services would split one citizen-facing concern.
  identity-service already holds the PII key and an `SmsChannel` (OTP);
  one channel instance in `main.ts` serves OTP + both notices, so the real
  telecom adapter (ADR-021 follow-on #1) lands exactly once.

### Latent fix folded in

`application.accepted` was routed in the shared-events topic map since
ADR-017 but absent from kafka-init and the live broker — every ADR-017
proof ran on the in-memory bus, so real-Kafka mode had a silently dead
topic (the `vetting.age` gotcha class). Registered in kafka-init alongside
`application.withdrawn`; both created manually on the running broker.

## Proofs

- `verify-auto-withdrawal-slice` (extended): one summary event per
  acceptance, full payload, none on redelivery.
- `verify-notices-slice` (NEW, gate #36): real projector + real resolver
  composed on one bus — acceptance → sibling WITHDRAWN in PG → one SMS to
  the decrypted stored phone; body PII-free (no UUIDs); no duplicate on
  redelivery; PENDING_NO_CONTACT and FAILED recorded truthfully; no
  NOTIFICATION_DELIVERED; no phone/hash on any bus.
- `verify-erasure-slice` (extended): the execution SMS reaches the
  now-destroyed phone — proving pre-tombstone capture; nothing on
  re-erase or refusals; contact memory-only.
- `verify-applicant-self-service-slice` (extended): decline notice
  fixed-body with the ground text ABSENT; none on re-decline.

## Consequences

- ADR-017 #2 and ADR-020 #5 are closed; the citizen-communication loop
  (capture → deliver → notify on the three process outcomes) is complete.
- The audit trail now evidences every notice attempt with its delivery
  status — the Law N° 058/2021 answerability posture extends to what the
  citizen was told, not just what was done.
- `EraseIdentityOutcome.ERASED` and `DeclineRequestOutcome.DECLINED` carry
  a memory-only contact field; every consumer must uphold the never-log /
  never-persist / never-event discipline (enforced by proof leak checks).

## Follow-ons (explicitly out of scope, flagged)

1. **Real telecom adapter** (carried from ADR-021 #1) — all notices ride
   LogSmsChannel until a contract exists.
2. **Summary-event redelivery dedupe** — redelivery of the SUMMARY (not
   the acceptance) re-sends the withdrawal notice; acceptable on the
   dev-tier channel, revisit with the provider retry/queue work
   (ADR-021 #4).
3. **Officer-direct refusal notices** — ADR-015 refusals (409s) inform the
   officer in-band; whether the citizen is separately notified of a
   refusal that did not come through their own intake request is a
   DPO-process question.
4. **Retention-erasure notices** (ADR-019) — deliberately unsent; own
   legal wording if ever required.
5. **Notice localization** (Kinyarwanda/French/English) — bodies are
   English fixed strings pending owner/agency wording sign-off.
