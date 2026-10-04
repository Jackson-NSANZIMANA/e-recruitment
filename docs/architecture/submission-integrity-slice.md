# Submission integrity slice — an idempotent front door (ADR-027)

**Proof:** `services/application-service/selfcheck/verify-submission-integrity.ts`
**Migration:** `packages/shared-database/src/rls/0022_submission_integrity.sql`
**Manifest:** `services/application-service/selfcheck/front-door.manifest.json`

## What this slice guarantees

1. A retried `POST /v1/applications` is **answered**, never re-filed.
2. An idempotency key reused for a *different* submission is **refused**.
3. One citizen holds at most **one live application** per campaign and
   category — through the web front door, the walk-in lane, or both.
4. A withdrawn application **frees** that intent, so re-applying works.
5. The request, the application, its opening history row and its
   `APPLICANT_SUBMITTED` are **one transaction**.

## Running it

The proof needs PostgreSQL only — no Kafka, no MinIO. It boots the real
service over `@usrp/shared-http` on an ephemeral port, drives it through a
real socket, and cleans every row it touches before and after.

```bash
# tier1 up and the database bootstrapped (scripts/bootstrap-db.sh)
DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
npx tsx services/application-service/selfcheck/verify-submission-integrity.ts
```

It is registered in `scripts/run-selfchecks.sh` immediately after the
front-door proof, so `pnpm verify` (and therefore CI) runs it.

## What each section establishes

| § | Section | Establishes |
|---|---|---|
| 0 | Completeness manifest | Every artefact of the slice exists and still contains the symbol that makes it load-bearing. **No infrastructure** — fastest signal. |
| 1 | Canonical hash | Deterministic; independent of object key order; `null ≠ ""`; delimiter-bearing values cannot collide. |
| 2 | Engine | All three `uq_*_applications_live_intent` indexes exist, are UNIQUE, key `(applicant_id, campaign_id, category)` and are partial on `status <> 'WITHDRAWN'`. The ledger is append-only (no UPDATE/DELETE grant) under FORCE'd RLS. |
| 3 | HTTP contract | 201 → 201 + `Idempotency-Replayed: true` → 409 `KEY_REUSED` → 409 `ALREADY_APPLIED` → 400 on a malformed key. A keyless submission still gets a ledger row. |
| 4 | Atomicity | Exactly one application row, one history row, one ledger row (carrying the canonical hash) and **one** `APPLICANT_SUBMITTED` survive the whole sequence. |
| 5 | Concurrency | 8 parallel identical retries → exactly 1 filed, 7 replayed, same `applicationId`. 8 parallel **different** keys → exactly 1 filed, 7 `ALREADY_APPLIED`, and the losers' keys are left unspent. |
| 6 | Walk-in | A double-tap on the officer's tablet is a 409 naming the existing processing code, not a 500 — and announces nothing. A citizen who applied online cannot be registered again at the venue. |
| 7 | Withdrawal | The partial predicate is real: after `WITHDRAWN`, re-applying succeeds. |

## A defect this proof found

Section 5a initially failed with *"the other 7 replayed — 6"*: one of eight
identical concurrent retries returned `409 ALREADY_APPLIED` instead of
replaying.

The cause is `READ COMMITTED`, where every statement takes a fresh snapshot. A
competing delivery of the *same* request can commit between the ledger lookup
(step 1, which saw nothing) and the live-application lookup (step 2, which now
sees that request's application). The loser then concluded it was looking at
someone else's application.

It is a narrow window, and it is exactly the case idempotency exists for: the
caller sent the key it was given a result for and is owed that result. The
adapter now re-reads the key before concluding `ALREADY_APPLIED`. The fix is
in `PgSubmissionLedger.recordSubmission` with a comment pointing back at this
section.

## How the two mechanisms divide the work

They are not redundant:

- The **ledger** makes a retry *answerable* — it can return the original
  `applicationId` and `processingCode`. It depends on the client sending a
  stable key.
- The **partial unique index** makes the duplicate *impossible*, whatever the
  client does — no key, a fresh key each time, or a direct repository call
  that bypasses the use case entirely.

Drop the ledger and a correct retrying client gets a 409 it cannot interpret.
Drop the index and the invariant holds only while every caller cooperates.

## Schema notes

`public_core.submission_requests` is mirrored in
`packages/shared-database/src/schemas/submission-requests.schema.ts` and folded
into the latest drizzle snapshot, so `verify-schema-drift.ts` is green.

The three `uq_*_applications_live_intent` indexes are **not** modelled in the
drizzle mirrors. `verify-schema-drift.ts` compares only `idx_*`-named indexes
(see `docs/architecture/schema-evolution.md`), so adding a `uq_`-named index to
the snapshot would make the drift gate red forever. Each ops schema file
carries a comment recording the index, and §2 of this proof asserts its
existence, uniqueness and exact predicate against the **live** database —
a stronger check than a mirror.

## The blast radius: neighbouring proofs

`rls/0022` makes a rule true that the test fixtures of eight other proofs had
been quietly breaking: they parked several LIVE applications on one citizen in
one campaign and one category, because nothing stopped them. Those are not
scenarios the platform can ever see in production, so the fixtures — not the
rule — were wrong. Every one of them was corrected in the way the real world
would correct it:

| Proof | Was | Now |
| --- | --- | --- |
| `verify-submit-http-slice` | one submission, no key | sends an `Idempotency-Key`; §3a asserts replay, `ALREADY_APPLIED` on a fresh key, and that exactly one application exists throughout; teardown clears `submission_requests` |
| `verify-walk-in-slice` | re-registered the already-ACCEPTED candidate | second candidate for the hard-fail lane, plus a new §6b that asserts a double-tap on the officer's tablet returns 409 `ALREADY_APPLIED`, names the existing application and writes no second row |
| `verify-outbox-slice` | three submissions, one applicant | one applicant per submission (broker-down, failed-relay, lost-`CLEARED`); teardown clears `submission_requests` |
| `verify-officer-lifecycle-slice` | four RDF lanes + two RCS lanes on two citizens | one citizen per lane; the accept-lock assertions still key on applicant A |
| `verify-auto-withdrawal-slice` | same-campaign, same-category siblings | siblings in another **category** of the same campaign — which is what hedging across lanes actually looks like (note the index spares only `WITHDRAWN`, so the REJECTED RNP sibling moved too) |
| `verify-amber-adjudication-slice` | six RDF scenarios on one citizen | one citizen per scenario |
| `verify-vetting-projection` | ten applications on one citizen | one citizen per scenario; events carry the true owner via an `applicationId → applicant` map |
| `verify-field-sync-slice` | three biometric lanes on one citizen | one citizen per lane |

Two proofs in this service still fail for reasons that predate this work and
are untouched by it: `verify-application-detail-reads` (the "three-schema
intersection" column list in `application-read.pg-repository.ts` selects
`declared_specialist_field`, which exists in `rdf_ops` and `rcs_ops` but not
`rnp_ops`) and `verify-pipeline-e2e` (needs a Kafka broker).
