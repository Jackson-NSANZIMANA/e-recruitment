# ADR-017 — Auto-Withdrawal on Accept: WITHDRAWN's First Writer

**Status:** Accepted (owner-signed 2026-07-26)
**Related:** ADR-006 (single writer), ADR-014 (accept-lock — flagged this as its #1 follow-on), ADR-015 (erasure terminal set), rls/0007 (append-only history)

## Context

ADR-014's accept-lock made acceptance exclusive — one citizen, one acceptance,
platform-wide — but **block-only** (owner decision, 2026-07-26): the losing
in-flight applications simply went dormant. That left two debts:

1. **Stranded rows.** An accepted citizen's other applications sat at
   SUBMITTED / SLOT_ASSIGNED / ADJUDICATION_REVIEW forever — polluting officer
   queues, never resolvable (any later accept 409s off the lock), and
   blocking the citizen's right-to-erasure (ADR-015's gate requires every
   application terminal).
2. **An unreachable status.** `WITHDRAWN` existed in every schema enum and in
   the erasure gate's terminal set — with zero writers. 17 of 19 statuses
   were reachable; the lifecycle story had a hole where its most ordinary
   administrative outcome should be.

## Decision

### One acceptance retires everything else (owner D6, 2026-07-26)

When an officer accept lands (APPLIED — the lock won), **every other
non-terminal application of that citizen is auto-withdrawn**: all agencies,
all campaigns, both lanes, **including ADJUDICATION_REVIEW holds** — the
person is enlisted; the pending questions about them are moot. Terminal rows
(REJECTED / WITHDRAWN / ACCEPTED / WALK_IN_REJECTED) are never touched.

### Event-driven, as the system role — not inside the accept transaction

The accept path publishes a new PII-free domain event,
`APPLICATION_ACCEPTED` (topic `application.accepted`), carrying the
identifiers read under the accept's own row lock. A projection consumer in
application-service (its fifth ingress; ADR-006's single-writer rule holds)
performs the withdrawal in ONE transaction as `usrp_system_service`.

Why not synchronously inside the accept transaction:

- **The officer's role physically cannot.** An RDF officer's DB role has no
  grant on `rnp_ops`/`rcs_ops` — cross-agency isolation is the point. Only
  the system role sees all three schemas, and escalating roles mid-officer-
  transaction would puncture the isolation seam ADR-014 was built on.
- **Honest attribution.** No officer decided the siblings' fate; the
  acceptance did. A platform-level consequence belongs to the platform:
  history rows say `performed_by = 'SYSTEM'`, audits say
  `performedBy = 'application-service'`.
- **Durability for free.** The consumer inherits the projection contract:
  fault → offset uncommitted → redelivery; and redelivery after success
  finds nothing non-terminal → no-op (proven).

The withdrawal transaction is all-or-nothing across the three schemas, and
the status comparison runs on `status::text` — the rnp/rcs enums do not
carry the WALK_IN_* values, so an enum-cast IN-list would error on those
schemas.

### Every withdrawal is individually audited

One `APPLICATION_WITHDRAWN` audit entry per retired row, against the row's
**own** agency, carrying `previousStatus`, and metadata
`{cause: 'ACCEPTED_ELSEWHERE', acceptedApplicationId, acceptedByAgency}` —
an officer reviewing an RNP queue can see exactly why a row left it and who
won. Nothing withdrawn → nothing audited.

## Proof (gate #31 — `verify-auto-withdrawal-slice.ts`)

Live, re-runnable, green ≥2×: a REAL officer accept over HTTP (officer DB
role, accept-lock included) fans out on the same bus wiring production uses;
asserts the same-agency sibling, a sibling-agency SLOT_ASSIGNED row, and an
ADJUDICATION_REVIEW hold all reach WITHDRAWN; terminal controls untouched;
one history append per withdrawal from the true prior status; one audit per
row with cause + winner; redelivery of the same acceptance writes and emits
nothing.

## Consequences

- **18 of 19 statuses now reachable** (remaining: DRAFT — deliberate, the
  applicant-portal draft state, no writer until the portal exists).
- The erasure story completes for non-enlisted citizens: once an accepted
  citizen exists, every sibling ends terminal, so ADR-015's gate can pass
  for the *other* applicants a campaign leaves behind. (The enlisted citizen
  themself stays non-erasable by design — ACCEPTED is deliberately excluded
  from the erasure terminal set; post-discharge erasure remains an ADR-015
  follow-on.)
- Officer queues no longer accumulate zombie applications for enlisted
  citizens.

## Follow-ons (explicitly out of scope, flagged)

1. **Applicant-initiated (voluntary) withdrawal** — a citizen withdrawing
   their own application pre-acceptance; needs applicant auth (ADR-018) and
   an applicant-facing endpoint. WITHDRAWN's second writer.
2. **Notification of withdrawal** — telling the citizen their other
   applications were retired; blocked on contact capture (the
   notification-service ContactResolver follow-on).
3. **Unlock/appeal workflow** (carried from ADR-014) — a post-accept
   rejection would today leave the citizen locked AND their siblings
   withdrawn; an appeal path must reason about both.
