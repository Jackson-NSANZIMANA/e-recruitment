# ADR-027 — Submission integrity: idempotent front door, one live application per intent

**Status:** accepted (wave 4 of the P0 hardening programme)
**Date:** 2026-10-04
**Extends:** ADR-005 (HTTP transport), ADR-006 (state projection), ADR-012 (walk-in lane), ADR-025 (outbox)
**Depends on:** wave 2 (#15, transactional outbox) and wave 3 (#16/#17, slot integrity)

## Context: wave 2 made the retry safe to SEND, not safe to RECEIVE

ADR-025 fixed a real defect at the front door. A broker hiccup after the
commit used to return 500 for an application that **was** filed, so the
citizen was invited to file it again. Staging `APPLICANT_SUBMITTED` inside the
filing transaction removed that specific 500.

It left the other half untouched. Nothing on the receiving side could tell a
**retry** from a **new submission**:

| Step | Client | Server |
|---|---|---|
| 1 | `POST /v1/applications` | files `RDF-00041`, stages the event, commits |
| 2 | — | response lost (mobile network, kiosk timeout, LB reset) |
| 3 | client retries the identical request | files `RDF-00042`, stages a **second** event |

The citizen now holds two applications. Both enter vetting. Both consume a
NESA/HEC and a RIB G2G call. Both can reach `DOCUMENT_REVIEW_GREEN`, and
ADR-026's slot ledger — keyed on `application_id` — happily reserves **two
seats at two venues** for one person, because from its point of view they are
two different applications. The cross-agency accept-lock (ADR-014) does not
help either: it guards one citizen accepted by two *agencies*, not one citizen
holding two applications in the *same* agency.

And this was never only about retries. There was no rule anywhere — not in the
code, not in the schema — that a citizen may hold only one live application
per campaign and category. A determined applicant could simply POST twice.

Three things were missing, and they are not substitutes for one another:

1. **Request identity.** Without a key, the server cannot recognise a retry.
2. **Request content identity.** With only a key, the server cannot tell an
   honest retry from a client that reused a key for a different submission.
3. **An engine-level invariant.** Idempotency keys are a *client-cooperation*
   mechanism. A client that sends no key, or a fresh key each time, must still
   not be able to file twice.

## Decision

### 1. A submission ledger: the front door's decision of record (`rls/0022`)

`public_core.submission_requests`, primary key
`(applicant_id, idempotency_key)` — the pair the client controls — carrying
the `request_hash`, the `agency`, and the `application_id` + `processing_code`
that the request produced. `application_id` is UNIQUE, so one application can
never be claimed by two keys.

Append-only for its writer (`SELECT, INSERT` to `usrp_system_service`;
`UPDATE/DELETE/TRUNCATE` revoked), FORCE'd RLS. No foreign keys, for the same
reason ADR-026's slot ledger has none: applications live in three isolated
agency schemas, and the record that a request *was accepted* must outlive any
one of them.

### 2. The ledger row is written FIRST, in the filing transaction

`PgSubmissionLedger.recordSubmission` is one transaction:

1. ledger lookup — key seen? hash matches ⇒ `REPLAYED`; hash differs ⇒
   `KEY_REUSED`;
2. live-application lookup ⇒ `ALREADY_APPLIED`;
3. mint `application_id` + `processing_code`, then **INSERT the ledger row**
   with `ON CONFLICT (applicant_id, idempotency_key) DO NOTHING`;
4. INSERT the application and its opening history row;
5. stage `APPLICANT_SUBMITTED` in the outbox. Last.

**Step 3 is the ordering decision of this ADR.** Two concurrent deliveries of
the same request meet on the ledger's primary key: the second blocks on the
first's speculative insert and, once the first commits, takes the `DO NOTHING`
branch and replays. Had the application been inserted first, both would
already have filed before either reached the key.

Writing the identifiers *before* the application is why they are minted in the
adapter rather than defaulted by the database.

### 3. Canonical request hashing

`request_hash` is SHA-256 over a **fixed-order, length-prefixed** encoding of
the submission's business content (`applicantId`, `category`, `channel`,
`nesaIndexNumber`, `hecRegistrationNumber`).

- **Fixed order, not `JSON.stringify`.** `JSON.stringify` is key-order
  dependent, so a client that serialised its retry in a different order would
  be told `KEY_REUSED` for an identical submission.
- **Length-prefixed, not delimited.** With a plain delimiter,
  `nesa="A|B", hec=null` and `nesa="A", hec="B"` serialise to the same bytes —
  a collision reachable directly from user input, which would make two
  genuinely different submissions look like replays of each other.
- **Null ≠ `""`**, so "no credential supplied" and "empty credential" are
  different requests.

The hash deliberately excludes the campaign (resolved server-side) and every
trace field (correlation id, timestamps), which must not make an identical
retry look new.

### 4. The engine enforces the invariant regardless of the client

Three partial unique indexes, one per ops schema:

```sql
CREATE UNIQUE INDEX uq_rdf_applications_live_intent
  ON rdf_ops.applications (applicant_id, campaign_id, category)
  WHERE status <> 'WITHDRAWN';
```

`WITHDRAWN` is excluded on purpose (owner decision D1): withdrawing and
re-applying is legitimate, and a withdrawn application must not block a
citizen forever. Every other status — including the terminal `REJECTED` and
`ACCEPTED` — counts as live intent.

The migration **refuses to run** if any agency already holds duplicates, and
names how many. Citizen records are never silently de-duplicated; an operator
resolves them by hand.

A 23505 on these indexes is classified by **constraint name**, not merely by
SQLSTATE, and turned into `ALREADY_APPLIED`. Matching on 23505 alone would
report a `processing_code` or `qr_invitation_code` collision as "you already
applied" — a lie that would hide a real bug.

### 5. The HTTP contract

| Case | Status | Body / header |
|---|---|---|
| first submission | `201` | `{status: SUBMITTED, applicationId, processingCode, agency}` |
| same key, same body | `201` | identical body + `Idempotency-Replayed: true` |
| same key, different body | `409` | `{status: KEY_REUSED}` — **no identifiers** |
| different key, live duplicate | `409` | `{status: ALREADY_APPLIED, applicationId, processingCode}` |
| malformed key | `400` | `INVALID_IDEMPOTENCY_KEY` |

A replay **keeps its 201**. The response is the original answer repeated
verbatim, so a client that only reads the status behaves identically whether
or not its first attempt survived — which is the entire point of a retry. The
header is how a client that cares can tell.

`KEY_REUSED` carries no identifiers deliberately: the key belongs to a
different submission, and echoing that submission's ids to a caller asking
about another one would leak across requests.

The key is **optional**. Without one the server mints a key so every accepted
submission still has a ledger row; such a request simply has no retry identity,
and its duplicate is caught by §4 as `ALREADY_APPLIED` rather than replayed.

### 6. The walk-in lane is bound by the same invariant

The on-site lane files into the same `applications` table, so the index
governs it too. `PgWalkInRepository` classifies the refusal and returns
`ALREADY_APPLIED` with the existing processing code, so the officer can pull
up the application the candidate already holds. A duplicate registration
writes no row, mints no ticket, and — importantly — **emits no second
`APPLICANT_SUBMITTED`**, which would otherwise re-run the autonomous gates
against an application already in vetting.

### 7. A completeness manifest for the front door

`services/application-service/selfcheck/front-door.manifest.json` enumerates
every artefact this slice requires — migration, drizzle mirror, snapshot,
hashing, port, adapter, use case, HTTP adapter, composition-root wiring,
walk-in handling, gate registration, these documents — with the symbol that
makes each load-bearing. Section 0 of the proof asserts all of them, with no
infrastructure.

This exists because of what actually happened: an earlier attempt at this
slice landed **only** `rls/0022`. The table existed and nothing ever wrote to
it, the schema-drift gate was red for an unmirrored table, and the front door
still filed a second application for every retried POST. A half-applied slice
is worse than an unstarted one — the schema claims a guarantee the behaviour
does not provide.

## Consequences

- **A retried submission is answered, not re-filed** — proven under 8-way
  concurrency, where exactly one request files and seven replay with the same
  `applicationId`.
- **A reused key is refused** rather than silently resolved either way.
- **One citizen, one live application per campaign + category**, through the
  digital front door, the walk-in lane, or any mixture — enforced by the
  engine, so a future caller that bypasses the ledger still cannot violate it.
- **No duplicate G2G spend and no double seat reservation**, which is what the
  duplicate ultimately cost.
- **Withdrawal genuinely frees the intent**: the partial predicate is proven,
  not assumed.
- `PgApplicationRepository.createApplication` (the direct, non-idempotent
  path used by proof fixtures) now surfaces a live-intent refusal as an
  `ApplicationPersistenceError`. Callers that need the business answer go
  through the ledger.
- The front-door INSERT lives in exactly one place
  (`adapters/application-insert.ts`), shared by both write paths, so the
  idempotent and direct paths cannot drift apart.

## Alternatives considered

- **Unique index alone, no ledger.** Cheapest, and it does stop the duplicate
  — but a retry then gets a `409` instead of its original `201`, so a correct
  client that retried cannot distinguish "my first attempt worked" from "I am
  rejected", and has no way to learn the processing code it was already
  assigned. The ledger is what makes the retry *answerable*.
- **Ledger alone, no index.** Idempotency keys are client cooperation. A
  client sending a fresh key per attempt would file twice, and the invariant
  would hold only as long as every current and future caller behaved.
- **Hash the whole request body as received.** Rejected: it makes the hash
  depend on key order, whitespace and any field a proxy might add, so honest
  retries would be reported as `KEY_REUSED`.
- **`SELECT … FOR UPDATE` on the applicant row to serialise submissions.**
  Serialises *all* of a citizen's submissions across every agency, and still
  needs the index as a backstop. The partial unique index gives exactly the
  scope the rule has.

## A defect found in review: the retry contract must outlive its state

The first implementation resolved a re-presented key *inside*
`recordSubmission` — which runs after the use case has already read the
applicant's identity and resolved an **open** campaign. The replay was
therefore conditional on state that moves underneath it.

The failure is the exact scenario this slice exists for. A citizen submits,
the 201 is lost on a dropped mobile connection, and they retry later — after
the registration window has closed. They were answered `NO_OPEN_CAMPAIGN`:
told they had never applied, while their application sat filed in the
database. An identity whose status changed between submission and retry
produced the same class of lie.

A retry is a question about the **past** — *"what did you answer me?"* — so it
must be answerable from the ledger, which is immutable, and never from the
present. The ledger port therefore gained a read-only `resolveKey`, and the
use case now runs:

```
validate the request (pure)  →  hash it (pure)  →  ANSWER A KNOWN KEY
    →  identity  →  campaign  →  record
```

Only an **unseen** key is a new submission and faces the preconditions. The
in-transaction check inside `recordSubmission` stays exactly as it was: it is
the serialisation point for concurrent same-key deliveries, which no
pre-check can close.

§3b of `verify-submission-integrity.ts` holds this, and it is load-bearing —
disabling the pre-check turns it red. Note that of its two assertions only the
**identity** one is environment-independent: with this campaign closed,
`findOpenCampaign` may select a *different* open RDF campaign, in which case
the submission proceeds and the in-transaction check replays it anyway. Which
leads to the next point.

### What trying to assert the boundary revealed

The obvious companion assertion — *"a brand-new key under a closed campaign is
refused"* — is deliberately **not** made. Attempting it showed that when the
citizen's campaign is closed and another RDF campaign is open,
`findOpenCampaign` selects that other campaign and the submission succeeds as
a **second application in a different campaign**. The live-intent index is
keyed per campaign, so nothing stops it.

That is item 2 below — cross-campaign duplicate intent — demonstrated
concretely rather than hypothetically. It is an owner policy question, and the
answer currently depends on which other campaigns happen to be open, so
asserting it would pin down an accident of fixture ordering rather than a
property of this slice.

## Not done here

1. **Ledger retention.** Rows are permanent today. They are PII-free
   (opaque ids, a hash, a processing code) but they are linkable to a citizen
   and belong on the ADR-015 erasure road — a **DPO decision**, listed the
   same way ADR-026 listed `slot_reservations`.
2. **Cross-campaign duplicate intent.** The invariant is per campaign. A
   citizen may hold live applications in two different campaigns of the same
   agency. Whether that is legitimate is an owner policy question, not a
   technical one.
3. **Edge-tier passthrough of `Idempotency-Key`.** The service contract is
   ready; the browser boundary (ADR-021) is not. Stated precisely, because
   "the edge does not forward the header yet" undersells it:

   - `POST /v1/applications` is **not exposed through the edge gateway at
     all**. There is no `submitApplication` entry in
     `edge-gateway/src/domain/upstream-operations.ts`; the citizen online
     front door is still system-credentialed only. So there is nothing to
     forward *yet* — but the header is the first thing that must be wired
     when that operation is added, not an afterthought.
   - **Both directions are trapped by design.** `upstream.http-gateway.ts`
     builds the upstream header set from scratch, under the comment
     *"Nothing from the browser's header set appears here"* — a deliberate
     and correct default that will silently drop `Idempotency-Key`. And
     `UpstreamResult` is `{ status, body }`: response headers are discarded,
     so `Idempotency-Replayed: true` cannot reach the browser either. Both
     need an explicit, narrow exception; neither should be solved by
     relaxing the default.
   - `EDGE_IDEMPOTENCY_KEY_REUSED` already exists in the audit event union of
     `edge-gateway/src/ports/audit-logger.ts` and is **never emitted**, and
     `idempotencykey` is already in the audit redaction set. Someone began
     this and stopped. The follow-up should either emit that event or delete
     it — dead vocabulary invites the reader to assume a mechanism that is
     not there.

   The walk-in path **is** exposed through the edge, and a first reading of
   `upstream.http-gateway.ts` (which returns `{ status, body }` verbatim for
   anything that is not 3xx or 502/503/504) suggested the new
   `409 ALREADY_APPLIED` already reached the officer's tablet intact. **That
   was wrong**, and writing the assertion instead of trusting the reading is
   what caught it: above the transport sits a per-outcome projection,
   `conflictResult`, which switches on known upstream statuses.
   `ALREADY_APPLIED` was not one of them, so it fell through to the default
   and arrived as `ILLEGAL_TRANSITION` **with both identifiers dropped** — a
   wrong label on an answer the officer could no longer act on, defeating the
   exact reason the service returns the processing code. Fixed here, with
   §11b of `verify-edge-security.ts` holding it: the case is explicit, the
   identifiers are kept, and the comment records why this is the opposite
   choice to the `CROSS_AGENCY_LOCKED` case directly above it (that one names
   *another* agency's data and is an enumeration oracle; this one names the
   officer's own, for a candidate standing in front of them, already
   reachable via `listApplications`).
4. **Idempotency for the other write endpoints.** Officer transitions,
   adjudication and self-withdrawal are all state-machine guarded (a repeat
   is `NO_CHANGE`), so they are safe but not *replayable*. Extending the
   ledger to them is a separate slice.
