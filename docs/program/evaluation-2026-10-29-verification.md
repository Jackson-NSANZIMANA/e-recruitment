# Verification of the 2026-10-29 full-system evaluation

**What this is.** A line-by-line code audit of [`evaluation-2026-10-29.md`](evaluation-2026-10-29.md) against the backend
at `b004fca` (the `main` that merged #53). It answers one question per claim: *is this true of the code in this
repository, and is it the whole truth?*

**Method and limits.** Static reading only. This audit environment has no Docker, no Postgres, no built workspace
and no frontend checkout, so nothing in §1 of the evaluation ("proven live") could be re-run, and every claim about
`e-recruitment-ui` is out of scope. What *is* checkable — the defect mechanisms, the guards around them, and the
arithmetic of §3 — was checked, with file and line evidence below. Ratings (§3) are judgement calls and are not
re-litigated; what is re-litigated is whether the **built/missing** columns that justify them are accurate, and
two of them are not.

**Headline.** Of the eleven defects, six stand exactly as reported, two stand but are **understated** (D1, D10),
one stands with a **wider fix** than written (D7), one is **half wrong** (D11) and one is **wrong about what the
code does** (D8). The audit also found **four defects the evaluation missed** — and one of them, D12, is the same
agency-divergence class as D1 in three further places, two of which break the Field Station and the physical-test
projection for RNP and RCS outright. That is what makes D1's structural fix (Phase-0 item 1) the highest-value
change in the report, for a reason the report does not give.

---

## 1. Verdict summary

| # | Reported state | Verdict after audit | Note |
|---|---|---|---|
| D1 | open | **Confirmed, and understated** | Not one missing column: one instance of a class. Three more instances exist (§3, D12). |
| D2 | open | **Confirmed** | 6 attempts / 15.5 s, then the DLQ. Nothing in the platform re-drives a dead letter; replay is a manual script. |
| D3 | fixed | **Confirmed fixed** | 2 000 ms bounded wait; the send continues afterwards. |
| D4 | fixed | **Confirmed fixed** | Both normalisers accept the listed spellings. Two independent implementations — see §5 note. |
| D5 | fixed | **Confirmed fixed** | PID is signalled only while `ps -o command=` shows a path inside this checkout. |
| D6 | fixed | **Confirmed fixed** | `AllowlistSmsChannel` refuses before the provider; the launcher maps `TWILIO_TO` → `SANDBOX_SMS_ALLOWED_TO`. |
| D7 | open | **Confirmed, and the fix is wider** | Two closed allowlists, not one, plus a 502 collapse. §2.7. |
| D8 | open (confirm intent) | **Wrong about the code** | The corrected bytes *are* stored. The real residual defect is different (D14). §2.8. |
| D9 | open | **Confirmed** | `startHttpServer` defaults to `0.0.0.0`, no service passes a host, and **no env knob exists**. |
| D10 | open | **Confirmed, and understated** | Two unreachable classes of hold, not one. §2.10. |
| D11 | open | **Half right** | 500 on a non-UUID is real. "The edge session carries no officer subject" is false. §2.11. |
| **D12** | — | **New** | `is_walk_in` / `sync_conflict_resolution` are RDF-only and read agency-agnostically in **three** shared paths. |
| **D13** | — | **New** | The platform cannot record "delivered"; no status-callback route exists. |
| **D14** | — | **New** | A re-upload after a human document review keeps the human verdict stamps (queue blindness). |
| **D15** | — | **New** | One infra fault fails a whole score batch; survivable today only because a batch is single-agency by accident (§3). |

---

## 2. The eleven reported defects, one by one

### D1 — `sms_notification_status` — CONFIRMED, and it is a class

`packages/shared-database/src/migrations/0000_grey_the_stranger.sql:296` declares the column inside
`rdf_ops.applications` only. `rnp_ops.applications` and `rcs_ops.applications` (same file, same CREATE TABLE block
pattern) never receive it, and no later `rls/00NN` adds it — `grep -rn sms_notification_status` over
`packages/shared-database/src/migrations` and `src/rls` returns that one line.

The write is agency-agnostic. `services/application-service/src/adapters/application.pg-repository.ts:381-390` and
`:399-406` build the statement against `${schema}`, where `schema = AGENCY_TARGET[result.agency].schema`, and set
`sms_notification_status = ${result.deliveryStatus}` in the same `UPDATE` that moves the row to
`PHYSICAL_TEST_SCHEDULED`. So for RNP/RCS the statement fails with `42703 column "sms_notification_status" does not
exist`, the transaction rolls back (status included), the consumer retries six times and dead-letters. The
evaluation's description is exact, including "never leaves `SLOT_ASSIGNED`".

Two things the report does not say, both of which matter:

1. **The read path is deliberately built to hide this.** `services/application-service/src/ports/application-read-repository.ts:76-91`
   documents that `ApplicationDetail` is "the INTERSECTION of the three ops schemas" *because* agency-divergent
   fields make reads throw "for RCS officers and nobody else". The same reasoning was applied to reads and not to
   this write. The comment at `:81-84` names `sms_notification_status` as rdf-only — so the divergence was known
   and written down, and the write was still added.
2. **It is not an isolated slip.** Three further agency-agnostic statements read RDF-only columns — D12 below. The
   right closure is therefore not "add a column" but "make this class impossible"; the report's Phase-0 item 1 is
   correct and should be the *first* thing built, before the column.

Also worth stating for the migration's design: `deliveryStatus` carries `DELIVERED | FAILED | PENDING_NO_CONTACT`
(`services/notification-service/src/application/deliver-invitation.service.ts:50-64`); the longest is 19 characters,
which fits the `varchar(20)` already used on `rdf_ops`. Mirror the column definition byte-for-byte.

### D2 — no re-drive after the DLQ — CONFIRMED

`packages/shared-events/src/dead-letter.ts:81` — `maxHandlerAttempts: 6`, `baseBackoffMs: 500`, capped at 15 s:
attempts at 0, 0.5, 1.5, 3.5, 7.5 s, then a final attempt, i.e. six invocations in ≈15.5 s, exactly as reported. The
loop is `packages/shared-events/src/kafka-bus.ts:202-226`: a `NonRetryableEventError` is parked at once, otherwise
the budget is spent, then `deadLetter()` publishes the original bytes to `events.dead-letter` with headers.

Nothing consumes `events.dead-letter`. `packages/shared-events/scripts/replay-dead-letters.ts` exists, is
dry-run by default, and is an **operator** tool. The only periodic *business* work is
`services/application-service/src/main.ts:133-150` (the stalled-clearance re-announce); the edge's two sweepers
(`services/edge-gateway/src/main.ts:90,105`) and the outbox relays (`packages/shared-database/src/outbox.ts:210-224`,
a 1 s poll) cannot help: a dead-lettered event has already been published and its offset committed. So an Irembo
429/503 that outlasts 15.5 s ends in a parked event and no result.

Two supporting facts the fix must respect:

- The clearance consumer is its **own group** (`services/background-vetting-service/src/adapters/events/clearance-certificate-submitted.consumer.ts:18`),
  so an outage parks only that reaction — good for blast radius, no help to the citizen.
- The citizen-facing state is already written before the throw: `verify-clearance-certificate.service.ts:140-150`
  records a best-effort `PENDING`/`REGISTRY_UNAVAILABLE` verification row. So "the citizen stays at verifying" is a
  literal description of a durable row, not a transient UI artefact — which means the re-drive has a natural key to
  sweep on (rows in `clearance_certificate_verifications` with `outcome='PENDING'` older than N minutes), and does
  not have to depend on reading the DLQ topic at all. That is the cheaper, testable design; the DLQ stays the alarm.

### D3 — the 8 s edge timeout vs a 12 s Twilio — FIXED (verified)

`services/identity-service/src/application/applicant-auth.service.ts:105-110, 219-224`: the OTP request races the
send against `otpSendWaitMs ?? 2000`, clears the timer, and answers `CHALLENGED`; the send continues in the
background, so a slow provider neither fails the citizen nor cancels the message. The comment on `:107-108` states
the reasoning (two 8 s edge attempts). Accepted.

### D4 — phone spellings — FIXED (verified)

`services/identity-service/src/domain/rwanda-phone.ts:30-46` strips `\s().-`, folds `00…`, folds a trunk `0` after
`+250` (`/^(\+?250)0(?=\d{9}$)/`), then admits `+250…`, `250…` or `0…` and requires an agreed prefix
(`72/73/78/79`). `packages/shared-sms/src/phone.ts:18-34` does the same for the delivery floor. Both return `null`
rather than throwing, so a malformed shape is a business answer, not a generic 500. Accepted.

### D5 — `sandbox:down` and reused PIDs — FIXED (verified)

`tools/g2g-sandbox/scripts/sandbox.ts:291-311`: `ownedProcess(pid)` returns false unless `ps -o command= -p <pid>`
contains the repository path, and `stopProcesses` signals the process group only when that holds, then removes the
PID file either way. `infrastructure/sandbox/full.sh:47-57` applies the same rule to the three app servers, using
`/proc/<pid>/cwd` **or** the command line against both checkouts. Accepted. (Residual, not a defect: `ps` output for
a long command line can be truncated on some libc/BusyBox builds; the `cwd` clause in `full.sh` is the stronger of
the two and is not in `sandbox.ts`.)

### D6 — sandbox SMS destination guard — FIXED (verified)

`packages/shared-sms/src/create-sms-channel.ts:90-105` requires `SANDBOX_SMS_ALLOWED_TO` whenever
`SANDBOX_SMS=twilio` in the sandbox, and forbids a real base URL unless that opt-in is present;
`:125` wraps the channel in `AllowlistSmsChannel`, which refuses (returns `FAILED`, logs) before the provider is
called. `tools/g2g-sandbox/scripts/sandbox.ts:245-249` derives the allowlist from `TWILIO_TO` and **deletes**
`TWILIO_TO`, so the number never reaches a service. Accepted.

### D7 — `400 INVALID_DOCUMENT_TYPE` becomes `503 UPSTREAM_UNAVAILABLE` — CONFIRMED, and wider

The chain, exactly:

1. `services/document-forensics-service/src/adapters/http/upload-document.controller.ts:166` answers
   `400 { error: 'INVALID_DOCUMENT_TYPE' }` when the type is not in any agency's set.
2. `services/identity-service/src/adapters/document-upload.http-gateway.ts:32-41` lists the refusals it will relay.
   `INVALID_DOCUMENT_TYPE` is **not** in it (`UNSUPPORTED_DOCUMENT_TYPE` is — a different code, emitted by
   `upload-document.service.ts` when the type is valid but not for this agency). So `:92-99` falls through to
   `DEPENDENCY_UNAVAILABLE`.
3. `services/identity-service/src/adapters/http/applicant-documents.controller.ts` maps that to
   `502 { status: 'DEPENDENCY_UNAVAILABLE' }`.
4. `services/edge-gateway/src/adapters/upstream.http-gateway.ts:205-217` treats **any** upstream 502/503/504 as a
   dependency fault and throws `UpstreamUnavailableError('UPSTREAM_UNAVAILABLE')`, which the guard turns into
   `503 { error: 'UPSTREAM_UNAVAILABLE' }`.

The report's fix note ("D7, identity document door") is necessary but **not sufficient**: even after identity relays
it as a 400, `services/edge-gateway/src/adapters/http/citizen.controller.ts:130-143` will answer
`502 UPSTREAM_CONTRACT_MISMATCH`, because `INVALID_DOCUMENT_TYPE` is not in the edge's closed `SAFE` set either.
Three allowlists move together, or the citizen sees the same wrong answer one layer further out. This is
also the reason the defect is invisible to the selfchecks: each hop is individually correct and no proof drives a
malformed document type end to end.

### D8 — "the corrected file is not stored" — WRONG ABOUT THE CODE

`services/document-forensics-service/src/domain/object-key.ts:12-31` is an explicit, argued product decision: the
object key is `agency/applicationId/documentType` with no hash and no timestamp, so a re-upload lands on the
**same** key; `MinIO` overwrites the object and `document_records` updates the same row. The write order confirms
it: `upload-document.service.ts` calls `objectWriter.putObject(...)` before `recordStore.recordVerdict(...)`, and
`document-record.pg-store.ts:60-84` UPDATEs the existing row by that same key. So the corrected bytes **are**
stored, and the repeated `documentId` is the row identity the design deliberately keeps. The report's "confirm the
intent" was the right instinct; the intent is documented and defensible (the alternative leaves superseded copies of
national IDs at rest under keys no row points at).

The real residual defect in this area is different, and nobody has written it down — see **D14**.

### D9 — the sandbox edge listens on `0.0.0.0` — CONFIRMED

`packages/shared-http/src/server.ts:129-135` — `host = '0.0.0.0'` is the default and
`packages/shared-http/src/types.ts:130-131` documents the parameter. `services/edge-gateway/src/main.ts:121-128`
passes `serviceName`, `port`, `routes`, … and **not** `host`. There is no `*_HOST` / bind-address variable in any
service config (`grep -rn "HTTP_HOST\|BIND_HOST" services/*/src/config.ts` → nothing), so this is not a profile
setting that the sandbox forgot to set: the knob does not exist yet.

The inconsistency that makes this a fair criticism rather than a nicety: the same sandbox profile already
loopback-binds every container it starts — `infrastructure/docker/docker-compose.sandbox.yml:47-48, 91-92, 108-109`
publish `127.0.0.1:4992`, `127.0.0.1:4993`, `127.0.0.1:4995`. Only the eleven Node services and the edge are on every
interface, and they are the ones holding session credentials. The fix is one config field, threaded in
`main.ts`, defaulted to `0.0.0.0` for container platforms and set to `127.0.0.1` by the sandbox launcher.

### D10 — nothing resolves a criminal `UNDER_REVIEW` — CONFIRMED, and understated

`services/application-service/src/adapters/application-read.pg-repository.ts:97-107`: the amber queue includes
`a.criminal_clearance_status = 'UNDER_REVIEW'` (for any row whose top-level status is not terminal) **and**
`a.academic_status = 'PENDING' AND a.academic_eligibility_detail->>'failureCode' = 'NESA_REVIEW_REQUIRED'`.
So two classes of hold are visible in the queue.

`services/application-service/src/adapters/officer-transition.pg-repository.ts:52-55, 334-336`: `adjudicate` accepts
only `DOCUMENT_REVIEW_AMBER` and `ADJUDICATION_REVIEW`, and returns `NOT_APPLICABLE` for anything else. A row held at
`CRIMINAL_CLEARANCE` (the lifecycle treats criminal `UNDER_REVIEW` as a HOLD, not a fail —
`services/application-service/src/domain/lifecycle.ts:26-29`) therefore cannot be moved by any operation. Same for
a NESA-review hold. The edge registers no operation that could: there are 68 operations
(`services/edge-gateway/src/domain/edge-operations.ts`) and none of them writes a vetting verdict.

So the report's "the amber queue shows it, nothing acts on it" is right, but the dead-end is **two** dead-ends, and
the fix has to name which one each queue row is, or the officer gets a screen with a button that silently refuses
half its rows. `queueReasons()` (`application-read.pg-repository.ts:332-346`) already emits the closed vocabulary
that distinguishes them (`CRIMINAL_RECORD_REVIEW` / `CLEARANCE_*` vs `NESA_*`), which is the natural discriminator.

### D11 — field sync — HALF RIGHT

**True:** a non-UUID `capturingOfficerId` yields 500. `services/edge-gateway/src/adapters/http/field-sync.controller.ts:113-117`
validates it as a bounded string only (deliberately: it is inside the device-signed payload), and
`services/field-sync-service/src/adapters/http/sync-scores.controller.ts:87-95` likewise. It then reaches
`INSERT … capturing_officer_id` (`field-score-store.pg.ts:143`) whose column is `uuid`, so PostgreSQL raises 22P02,
`FieldSyncPersistenceError` wraps it, and the service answers 500. A 400 is the honest answer: the *shape* of the
field is checkable without touching the signature.

**False:** "the edge session carries no officer subject". It does.
`services/edge-gateway/src/domain/session.types.ts:30` — `readonly subjectId: string | null` — persisted at
`adapters/session-store.pg-repository.ts:164-181` (`subject_id`, with a check that an officer session has one) and
set at login (`adapters/http/officer-auth.controller.ts:90,104,130`). The DB column exists in
`public_core.edge_sessions` (rls/0019).

What is actually missing is **forwarding and comparison**: the edge's `syncFieldScoresHandler` forwards the client's
`capturingOfficerId` verbatim and never sends the session's subject; `SyncFieldScoresService` receives only
`actorAgency`; and `resolveConflict` (`services/field-sync-service/src/adapters/field-score-store.pg.ts:180-240`)
receives neither the resolving officer nor the capturing officer, so the four-eyes rule ("the officer who resolves a
conflict differs from the one who captured it") is unexpressible. The data to check it is already in
`physical_test_scores.capturing_officer_id`, and the identity to check it against is already in the edge session.
That is a small, contained fix — and much smaller than the report implies.

---

## 3. Defects the evaluation missed

### D12 (new, highest severity of the four) — the D1 class has three more instances

Column sets differ across the three ops schemas (from `migrations/meta/0004_snapshot.json`, which the drift proof
keeps equal to the live DB). For `applications`, `rdf_ops`-only columns are
`document_review_notes, is_walk_in, medical_fitness_status, medical_reviewed_at, medical_reviewed_by_id,
sms_notification_status`; for `physical_test_scores`, `sync_conflict_resolution` is `rdf_ops`-only.

Most of those are used only behind agency-conditional SQL, which the code does well:
`declared_specialist_field` is emitted as `NULL::varchar` for RNP (`application-read.pg-repository.ts:160-170`),
`applied_criminal_threshold` is appended only for RNP (`application.pg-repository.ts:203-210`), and the medical
board's RDF-only columns are reached only in `BOARD` mode, which is derived from the agency. Three statements are
not guarded:

| Where | Statement | Effect for RNP/RCS |
|---|---|---|
| `services/field-sync-service/src/adapters/field-score-store.pg.ts:82-87` | `SELECT campaign_id, is_walk_in, qr_invitation_code FROM <agency>.applications … FOR UPDATE` (the score-sync path, `sync()`) | `42703`. Every online score upload fails; the use case treats it as an infra fault, so the **whole batch 500s** |
| same file `:186-192`, `:226-231` | `SELECT … is_walk_in`, then `UPDATE … SET sync_conflict_resolution` (conflict resolution) | `42703` twice; the conflicts screen cannot work for RNP/RCS |
| `services/application-service/src/adapters/application.pg-repository.ts:446-449` | `SELECT status, applicant_id, is_walk_in …` in `applyPhysicalTestComplete` | `42703`; the projection retries and dead-letters, so an RNP/RCS candidate never reaches `PHYSICAL_TEST_COMPLETE` |

Consequences worth stating plainly:

- **The Field Station is RDF-only by accident, not by design.** Every RDF-only proof passes (the pilot is RDF), and
  the offline/online lane silently cannot serve two of the three agencies. Any "field capture works" statement in
  §3.1 for field-sync-service (65%) is true of one agency.
- **The physical-test projection is RDF-only** for exactly the same reason, which is a second, independent break in
  the same funnel.
- `walk-in` correctly refuses RNP/RCS (`walk-in.service.ts:116,226` → `501 UNSUPPORTED_AGENCY`, collapsed to 403 at
  the edge), so the *lane* is safe; it is the projection and the score log that are not.

This is the argument for the report's Phase-0 item 1 being first, and for it being a **schema-shape gate**: assert
that the three schemas' column sets are equal modulo an explicit, justified allowlist, and add a second assertion
that every allowlisted column appears in no agency-agnostic SQL. Fixing D1 alone fixes a quarter of this.

### D13 (new) — the platform cannot record "delivered"

`packages/shared-sms/src/create-sms-channel.ts:77,121` accepts `TWILIO_STATUS_CALLBACK_URL` and
`twilio-sms.channel.ts:103,145` sends it to Twilio — but no service and no edge operation receives a callback
(`grep -rn "callback" services/notification-service/src/main.ts services/edge-gateway/src/routes.ts` → nothing;
the 68-operation registry has no inbound webhook). So `deliveryStatus = 'DELIVERED'` means *Twilio accepted the
message* (`deliver-invitation.service.ts:58-64` says so honestly), and `sms_notification_status` can never carry a
handset receipt.

Two consequences: the evaluation's §1 line "the owner's own OTP delivered by Twilio (`delivered`)" is an observation
of the Twilio console, **not of this system**, and should not be read as a proven platform capability; and the
report's own "notification-service … missing: status-callback route" is the right item, but it is a *correctness*
gap, not a nicety — any examiner-facing count of "citizens notified" built on this column will overstate delivery
and cannot distinguish "sent" from "received".

### D14 (new) — a re-upload keeps the previous human review stamps

`services/document-forensics-service/src/adapters/document-record.pg-store.ts:61-78` updates `document_type`,
bucket, size, virus scan, score, lane, flags and `forensics_completed_at` on a re-upload — and leaves
`human_reviewed_by_id`, `human_reviewed_at` and `human_review_decision` untouched. The amber queue's join requires
`d.human_reviewed_by_id IS NULL` (`application-read.pg-repository.ts:96-97`).

So: an officer reviews a document (say AMBER → verified), the citizen then re-uploads that document type, the bytes
and the forensics verdict are replaced — and the record still says a human reviewed it. The new, unreviewed bytes
are invisible to the reviewer. This is the genuine content of the report's D8 ("confirm the intent"): the identity
of the row should be stable, but the **human verdict is evidence about bytes that no longer exist** and must be
cleared (with an audit entry) whenever the object is replaced. At minimum, replacing the object should also stamp
`forensics_completed_at`/lane *and* reset the review columns; the alternative is a stale approval attached to fresh
content, which is the one thing a document-review control exists to prevent.

### D15 (new, small) — the batch is only defensible because batches are single-agency

`services/field-sync-service/src/application/sync-field-scores.service.ts:68-76, 136-160`: per-record outcomes are
the contract ("a rejected record does not stop the batch"), but only *business* outcomes are per-record. An infra
fault on any record — including D12's `42703` — throws out of `sync()` and fails the request. Because the edge
stamps a session-scoped batch and the use case is agency-scoped, this is currently single-agency and survivable;
it should still be a stated invariant ("one request never mixes agencies") rather than an accident of the edge's
shape, because the tablet re-upload story depends on it.

---

## 4. §1 "what was proven live" — what this repository can and cannot corroborate

| Claim | Corroborable from here? | Note |
|---|---|---|
| One command boots 16 units | Structure only | `infrastructure/sandbox/full.sh` stages exactly the described shape (11 services on 4901–4911 + edge 4921 + simulators + 3 Vite previews). The "+ edge" in the prose double-counts: `services/` has 12 directories **including** `edge-gateway`, and `full.sh`'s `status()` lists 11 service ports plus the edge. Cosmetic, but the same sentence is the report's headline number. |
| 24/24 citizen journeys | No | Requires the stack. The 24 is plausible: `up.sh` stages six campaigns and `full.sh` exports four persona sets + the clearance matrix. |
| Production boot posture | Partly | Verified in code: `assertProductionSecrets()` runs first in every `main.ts`; `services/biometric-service/src/index.ts:36` selects `NidaPortraitMatcher` in production, which fails closed; `assertDevAdapterAllowed` (`packages/shared-config/src/production-guard.ts:368-382`) refuses a dev adapter in production except the sandbox-permitted list; the edge refuses to boot with `EDGE_COOKIE_SECURE=false` in production (`edge-gateway/src/main.ts:53-59`). |
| Kafka: 582 audit records, 25 submissions | No | Counts only — nothing in the repository records them. |
| Document door (clean PDF, disguised file, EICAR) | Structure only | The refusals are real in code (`probeBytes` admission at `:164-176`, fail-closed scanner at `:179-183`, malware → audit and no row at `:187-203`). Note the door is **opt-in**: `SANDBOX_FORENSICS=1` (`tools/g2g-sandbox/scripts/sandbox.ts:72-75`), set by `sandbox:full` but not by `sandbox:up`. The report says "opt-in here", which is accurate for `sandbox:full`; a reader who runs `pnpm sandbox:up` will not have it. |
| Real SMS delivered | No — and see D13 | The system records acceptance, not delivery. |
| Agency isolation | Structure only | The mechanism is right (`FORCE`d RLS, `SET LOCAL ROLE` per statement, `verify-isolation.sql`), but note that D12 is a *schema-shape* leak across agencies, not an isolation leak: RLS cannot help when a statement names a column that one agency does not have. |
| Production bundles | No | Frontend checkout not present. |

---

## 5. §3 ratings — arithmetic checks out; two "built" claims are narrower than stated

The weighted figure is arithmetically sound: `0.35·72 + 0.20·62 + 0.10·55 + 0.15·10 + 0.10·18 + 0.05·35 + 0.05·25
= 25.2 + 12.4 + 5.5 + 1.5 + 1.8 + 1.75 + 1.25 = 49.4 ≈ 50`, and the unweighted "application functionality"
`(0.35·72 + 0.20·62)/0.55 = 68.4`. The unit averages also recompute: core services 72.5 → 72, apps 61.7 → 62.
Nothing to correct there.

Two of the supporting claims are narrower than the rating implies:

- **field-sync-service 65% — "online score capture, conflicts, device fleet".** True for RDF only (D12). For RNP and
  RCS, score capture and conflict resolution both fail at the first statement.
- **application-service 75% — "lifecycle, projections, adjudication, amber queue".** The physical-test projection
  is RDF-only too (D12), and the amber queue serves two hold classes it cannot resolve (D10).

Two are judgement calls that the code cannot settle and that this audit did not touch: the biometric 35% (the code
is an evidence contract with no model behind it — `adapters/mock-matcher.ts`, deliberately — so "35%" is a
programme judgement, not a code fact), and production platform 10% (nothing in this repository claims staging,
backup or metrics; `GET /version` only).

One residual fragility, not a defect: **the Rwandan phone rule exists twice**, with different accepted sets.
`services/identity-service/src/domain/rwanda-phone.ts` refuses any prefix outside `72/73/78/79` (correct for a
citizen's own contact number), while `packages/shared-sms/src/phone.ts` accepts any well-formed foreign E.164
(correct for a delivery floor). Both are right; both will drift, and the day they disagree the citizen gets an
`OTP_CHALLENGED` for a number the notifier refuses. A shared `MSISDN` module with two explicit policies would be
cheaper than the drift.

---

## 6. Corrected Phase 0 — order and content

The report's Phase-0 order is right in spirit; this audit changes the *contents* of items 1, 3, 4 and 5, and would
put the new gate first.

1. **The cross-agency shape gate, before the D1 column** (report item 1, promoted).
   `packages/shared-database/selfcheck/verify-cross-agency-column-parity.ts`, registered in
   `scripts/run-selfchecks.sh`: for `applications`, `physical_test_scores`, `document_records`, assert the three
   schemas' column sets are equal modulo a declared allowlist (`RDF_ONLY_COLUMNS`, `RNP_ONLY_COLUMNS`,
   `RCS_ONLY_COLUMNS`, each with a one-line reason), and assert every allowlisted name is absent from
   agency-agnostic SQL. Then fix, in one commit each: `sms_notification_status` (D1, `rls/0043`, mirror into
   `rnp-ops.schema.ts` + `rcs-ops.schema.ts` + a `0005_*` drizzle migration + snapshot, and register in
   `scripts/bootstrap-db.sh` after `rls/0042`), and the `is_walk_in` / `sync_conflict_resolution` statements (D12 —
   three statements across two services).
   *Note on numbers:* `rls/0037`, `0038`, `0039` are reserved for S10a/S14/P1 (`docs/program/README.md`), so the D1
   file is `0043`; the drizzle migration is the next free `0005_*` at rebase time.
   Each fix needs a proof that drives the path for all three agencies, not for RDF: the current `rnp-ops` and
   `rcs-ops` selfcheck coverage is exactly where this class survives.

2. **D2 as a product surface, not a replay tool.** Sweep the durable rows the citizen is waiting on — the
   vocabulary already supports it: `rls/0040`'s `clearance_verif_outcome_check` admits
   `CLEARED | REVIEW | CORRECTION_NEEDED | PENDING`, and the outage path writes `PENDING` with
   `failure_code = 'REGISTRY_UNAVAILABLE'` (`verify-clearance-certificate.service.ts:144`). Give the cap a terminal
   outcome — "we could not verify; a human will look" — so no row sits at `PENDING` for ever.

   *How the terminal outcome is reached (what the implementation proved).* The re-drive cannot be a timer over the
   durable row: the certificate number is deliberately never stored (only an HMAC and its last 4), so nothing in the
   database can reconstruct the registry call, and keeping the number to enable one would trade a citizen's privacy
   for our convenience. So the escalation hangs off the moment the event is given up on: `KafkaEventBus` takes an
   `onDeadLetter` observer, called once per event **after** its bytes are parked on `events.dead-letter` (so nothing
   the observer does — including throwing — can lose the event), and
   `background-vetting-service/src/adapters/events/clearance-dead-letter.observer.ts` answers for its own consumer
   group only, for `CLEARANCE_CERTIFICATE_SUBMITTED` only, and **only** when the terminal error is
   `ClearanceRegistryUnavailableError` — the one path that recorded nothing but `PENDING`. It calls
   `escalateUnverified()` → `REVIEW` / `CLEARANCE_UNVERIFIED` through the same deduplicating command function
   (`RECORDED` / `ALREADY_RECORDED`), and `rls/0044`'s function refuses a late escalation over a real verdict
   (`REFUSED` / `SUPERSEDES_VERDICT`), so a citizen who is already cleared cannot be walked backwards by a stale
   dead letter. Any other terminal failure is logged (`clearance_dead_letter_not_escalated`) and left to the alarm.
   Proven in `services/background-vetting-service/selfcheck/verify-clearance-slice.ts` §3b.

   `dlq:replay` / `replay-dead-letters.ts` therefore stays exactly what it was — the operator's path for events
   that should be re-driven by hand — and is no longer the only answer the platform has for an outage.

3. **D10 as two operations, or one operation with two lanes.** The backend must accept a vetting verdict for a row
   held at `CRIMINAL_CLEARANCE` (clear → recompute through the same pure lifecycle as the amber path) and for a
   `NESA_REVIEW_REQUIRED` academic hold. The queue row already carries the discriminator (`queueReasons()`); the
   operation should too, and refuse explicitly rather than returning `NOT_APPLICABLE` from a queue the officer is
   looking at.

   *How it landed (one operation, three lanes).* `domain/adjudication-lanes.ts` is the single predicate that answers
   "which holds does this row have" — `DOCUMENT` (the two statuses the operation already accepted), `CRIMINAL`
   (`criminal_clearance_status = 'UNDER_REVIEW'`) and `ACADEMIC` (`academic_status = 'PENDING'` +
   `failureCode = 'NESA_REVIEW_REQUIRED'`). The officer queue maps every entry through it (`heldLanes`) and
   `adjudicate` runs it again under `FOR UPDATE`, so the screen can only offer a lane the write will accept; the
   same list survives the edge's closed projections instead of being dropped there. `lane` is optional — absent
   means "the row's only hold" — and a row in two lanes refuses with the lanes rather than guessing: the edge maps
   that 409 to `ADJUDICATION_LANE_REQUIRED`, because by its own stated rule a refusal carrying an instruction needs
   its own case. CLEAR on CRIMINAL records `CLEARED` (+ `criminal_clearance_at`), CLEAR on ACADEMIC records
   `ELIGIBLE`, and the status is then re-derived by the SAME pure lifecycle as the amber path — with one guard: a
   verdict on one dimension never lifts another lane's hold, so the top-level status only moves when the decision
   removes the LAST hold. REJECT is a decision about the application, not a verdict about the registry (the
   dimension column keeps its evidence), and a dimension decision is audited even when the status does not move
   (`APPLICATION_ADJUDICATED`, carrying the lane) — otherwise the only trace of a human verdict would be a column
   value. Proven in `verify-amber-adjudication-slice.ts` §3b.

4. **D7 with all three allowlists, and D8 re-scoped to D14.** For D7: forensics keeps `INVALID_DOCUMENT_TYPE`;
   identity relays it as a refusal; the edge's `SAFE` set admits it. For D8: the repeat `documentId` is by design
   and should be documented as such in the upload contract; the defect to fix is that a re-upload does not clear
   `human_reviewed_*` (D14), with an audit entry.

5. **D9 and D11.** D9: add `host` to the shared HTTP options, default `0.0.0.0`, and set `127.0.0.1` for every
   process the sandbox launcher starts (the containers already do it). D11: a UUID shape check for
   `capturingOfficerId` (400, not 500) plus forwarding the session's `subjectId` to field-sync so the resolution
   path can enforce four-eyes — the identity exists already; nothing has to be added to the edge session.

6. **D13 before any "citizens notified" number is shown to anyone** — a callback route with signature validation,
   updating `sms_notification_status`, or an explicit product decision that the platform reports only "accepted".

---

## 7. What this audit could not settle

- Everything in §1 that needs a running stack, and every frontend claim (S06 screens, S10a/S10b, Field Station
  UI): no frontend checkout is present here.
- Whether the RNP/RCS breaks in D12 have ever been *observed*: no proof in `scripts/run-selfchecks.sh` drives the
  field lane or the physical-test projection for RNP or RCS, which is why they are invisible rather than reported.
  That absence is itself the finding, and the reason the shape gate belongs in the same change as the fix.
- The numeric rating band. Each of the four new defects lands inside a unit the report already rated 65–75%
  (application-service, field-sync-service, notification-service, document-forensics-service); a defensible
  re-rating would move those four down a little and the overall figure barely at all, because all four sit behind
  the pilot's RDF-only reality. That is a judgement for the owner, not for this document.

---

## 8. Implementation log — what Phase 0 shipped, and what pins it

Every line below was re-proven against a live PostgreSQL 16 cluster (schema from `bootstrap-db.sh`) and, where a
protocol is involved, over real sockets. The proofs are the ones `scripts/run-selfchecks.sh` runs, plus
`pnpm test` / `pnpm typecheck` / `pnpm lint` across the workspace.

| # | Outcome | Proof |
|---|---|---|
| D1 | `sms_notification_status` added to all three ops schemas (`rls/0043`, registered after `0042`; drizzle migration + snapshot). No statement changes: the column now exists where the agency-agnostic writer already wrote it. | `verify-cross-agency-column-parity` (live), `verify-schema-drift` (761 columns / 29 enums / 124 indexes, no drift) |
| D2 | The retry budget stays short; the DLQ gets a **terminal outcome**. `DeadLetterObserver` runs once per event AFTER the bytes are parked, and the clearance consumer escalates **only** `ClearanceRegistryUnavailableError` to `REVIEW` / `CLEARANCE_UNVERIFIED` (a human, not a `PENDING` row nobody reads). `rls/0044` refuses a late escalation over a real verdict (`REFUSED` / `SUPERSEDES_VERDICT`). The re-drive half is already satisfied by the bus (offset not committed → redelivery) and by `dlq:replay` for the operator; a timer-based re-drive is impossible by design because the certificate number is deliberately never stored. | `verify-clearance-slice` §3b |
| D7 | The door's fixable 4xx stops being reported as our outage: identity folds `INVALID_DOCUMENT_TYPE` onto `UNSUPPORTED_DOCUMENT_TYPE` before the edge's closed `SAFE` set sees it. | `verify-edge-contract`, `verify-edge-security` |
| D8/D14 | A re-upload overwrites the same object key by design, so the row stops claiming a human decision about bytes that no longer exist: `human_reviewed_*` cleared + audited, and the document returns to the amber queue predicate. A re-ANALYSIS of the same object does not withdraw a stamp. | `verify-document-review-replacement` (new, SQL-only, no MinIO/ClamAV) |
| D9 | `USRP_HTTP_BIND_HOST`, `0.0.0.0` by default; the sandbox launcher binds its twelve processes to loopback; an unrecognised value is a **boot refusal**, and `startHttpServer` is now `async` so that refusal is a rejected promise rather than an uncaught throw. | `packages/shared-http/test/bind-host.test.ts` (new) |
| D10 | One operation, three lanes — see §6 item 3. The queue names the lane (`heldLanes`), the edge preserves it, and `adjudicate` re-reads the lanes under `FOR UPDATE` before deciding. | `verify-amber-adjudication-slice` §3b |
| D11 | Non-UUID `capturingOfficerId` is a 400; the session's `subjectId` reaches field-sync, is forwarded to the resolver, and the `resolverIsCapturingOfficer` fact is recorded on the conflict resolution. | `verify-field-sync-slice` §5b |
| D12 | `is_walk_in` and `sync_conflict_resolution` are platform-wide (`rls/0043`); the field lane projects the walk-in flag per agency instead of assuming `rdf_ops`. | `verify-cross-agency-column-parity`, `verify-field-sync-slice` |
| D13 | **Open.** The verifier, the parser and the send-side `StatusCallback` form field all exist and are tested, and the application side already projects a delivery result (`applyNotificationDelivery` → `sms_notification_status` + `SLOT_INVITATION_DELIVERED`). What does not exist is the ingress, and it is blocked on a correlation decision, not on code: the callback URL is channel-level, so a callback carries only `MessageSid` and **nothing in the schema maps a sid to an application**. Three candidate fixes, in order of my preference: (a) a small `sms_deliveries` table owned by notification-service (`sid → application_id`, written at send time) — the only one that also answers "did we ever send this, and to which number class", and the only one that does not put a record id in a public URL; (b) a per-message `StatusCallback` URL carrying the application id (port change; Twilio signs the full URL, so verification still works); (c) an `sms_message_sid` column on all three `applications` tables. Any of the three then needs the public, unauthenticated route (edge, `publicAllowlist`) + signature verification inside notification-service, which holds the auth token. |
| D15 | **Open, small.** A batch is single-agency by accident of the edge's session shape; the invariant should be stated (and enforced with a cheap per-record isolation) rather than assumed. | — |

### The one defect this log added

While fixing D10's proof, a **fixture-only** defect turned out to be a class worth naming: several selfchecks wrote
jsonb columns through `JSON.stringify(...)::jsonb`. postgres.js serialises a string argument, so the column ended up
holding a JSON *string* (`jsonb_typeof(col) = 'string'`), and every reader downstream — including the edge's
`jsonObject` projection — quite correctly returned `null`. Production code already uses `sql.json(asJsonb(...))`
(and `packages/shared-database/src/client.ts` documents exactly this trap); the fixtures did not. They do now, and
the amber-queue proof asserts the flags object round-trips, so the fixture cannot drift back. The lesson generalises:
a proof that writes its own fixtures with a different shape than production proves nothing about production.
