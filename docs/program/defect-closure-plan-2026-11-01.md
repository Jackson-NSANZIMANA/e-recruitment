# Defect closure plan — D2, D7, D8, D9, D10, D11

**Status:** plan for approval · **no code written yet** · 2026-11-01
**Scope:** evaluation §2 (2026-10-29) defects **D2, D7, D8, D9, D10, D11**, executed as Phase 0 item 4 and the mechanical half of items 2–3 of evaluation §4.
**Out of scope, deliberately:** D1 (RNP/RCS `sms_notification_status`), D3–D6 (already fixed), the merges of #53/#55/#45/#46, and every S-numbered feature.
**Branch:** `arena/74feaf2b-e-recruitment` (backend checkout only — see §9).

---

## 0. Why this document exists

The evaluation is a narrative written from one laptop run. Before planning the fix I read the code path behind each defect. **Three of the six are misdescribed**, and one of them (D9) as written would break the M2 exam-day rehearsal. If we fix the description of the bug, we usually change the shape of the fix — so this document starts with ground truth, not with the defect table.

---

## 1. Ground truth: what the code actually does

| # | Evaluation's account | What the code actually does (file:evidence) | Real blast radius |
|---|---|---|---|
| **D2** | Irembo 429/503 → 6 retries in ~16 s → dead-letter queue → nothing re-drives it → citizen stuck at "verifying" | `packages/shared-events/src/dead-letter.ts` (`DEFAULT_DEAD_LETTER_POLICY`: 6 attempts, 0.5 s→15 s cap) → `kafka-bus.ts#deadLetter()` parks the letter with headers → `scripts/replay-dead-letters.ts` is a **manual, dry-run-by-default** operator tool with **no per-letter state, no backoff, no cap** → `verify-clearance-certificate.service.ts` records a best-effort `PENDING/REGISTRY_UNAVAILABLE` row then rethrows; `irembo-certificate.gateway.ts` maps *any* non-2xx to `ClearanceRegistryUnavailableError` | Every consumer group on every topic. One outage past ~16 s parks a citizen **permanently**, on all three lanes (RIB-by-hash, Irembo certificate, NESA/HEC). Not one defect — an architectural gap: **the platform has no recovery spine.** |
| **D7** | forensics `400 INVALID_DOCUMENT_TYPE` reaches the citizen as `503 UPSTREAM_UNAVAILABLE` | `document-forensics-service/adapters/http/upload-document.controller.ts` emits `INVALID_DOCUMENT_TYPE` (400) → `identity-service/adapters/document-upload.http-gateway.ts#REFUSALS` does **not** contain it → classified `DEPENDENCY_UNAVAILABLE` → `applicant-documents.controller.ts` 502 → `edge-gateway/adapters/upstream.http-gateway.ts#215` unknown code → `UPSTREAM_UNAVAILABLE` 503 | Same trap for **`SCANNER_UNAVAILABLE`**, `OBJECT_STORE_UNAVAILABLE`, `DOCUMENT_ENCRYPTION_ERROR`, `FORENSICS_PERSISTENCE_ERROR`. Three services agree on a vocabulary **that nobody owns**. The citizen is told "try again later" for something only they can fix, forever. |
| **D8** | "a second upload returns the first `documentId`; the corrected file is not stored. (confirm the intent)" | `domain/object-key.ts` derives a **stable** key (`agency/appId/type`) *by design*; `upload-document.service.ts` → `putObject` (MinIO PUT **overwrites**) → `document-record.pg-store.ts#73` finds the existing row and **UPDATES** it, returning the same `documentId`. `document_records` (rdf/rnp/rcs schemas) has **no revision column and no content hash**; `human_reviewed_by_id/at/decision` are **not reset**; `CLOSED_TO_UPLOADS` blocks only terminal statuses | The bytes **are** replaced. The real defects are worse than the report: **(a)** `documentId` is unchanged, so nobody can tell a document was replaced; **(b)** no hash/revision, so *"which bytes did the officer review?"* is unanswerable; **(c)** a document already reviewed **CLEAR** can be replaced afterwards and keeps its review stamp — **a citizen can swap the file the officer approved**; **(d)** uploads are allowed far past document review. This is evidence integrity, not UX. |
| **D9** | "the sandbox edge listens on `0.0.0.0`, not loopback only" | `packages/shared-http/src/server.ts#134` — `host = '0.0.0.0'` **default**; `edge-gateway/src/main.ts#121` never passes `host`. G2G simulators correctly bind `127.0.0.1` (`tools/g2g-sandbox/src/server.ts#75`) | **All 13 node processes** are LAN-reachable on a venue/laptop network, not just the edge. But "loopback only" is **wrong for the pilot**: M2 drives the system from **Galaxy Tab A7–A10 over the venue network** (ROADMAP §8.2, S08 kit). A blanket loopback bind makes the rehearsal impossible and gets "fixed" by whoever hits it, silently. The defect is that **exposure is the default and silent**, not that it exists. |
| **D10** | "no officer operation resolves a criminal-clearance `UNDER_REVIEW`" | `application-read.pg-repository.ts#listAmberQueue` surfaces rows with `criminal_clearance_status = 'UNDER_REVIEW'` **at any non-terminal status**, and NESA `NESA_REVIEW_REQUIRED` the same way → `domain/lifecycle.ts#deriveApplicationStatus` parks such a row at `CRIMINAL_CLEARANCE` (rank 4) → `officer-transition.pg-repository.ts#52` `ADJUDICABLE = {DOCUMENT_REVIEW_AMBER, ADJUDICATION_REVIEW}` → **`adjudicate` answers `409 NOT_APPLICABLE`** | Confirmed, and **wider than reported**: the NESA review hold is in exactly the same hole. Two queue reasons, zero verbs. A queue that shows work nobody can do is a lie the UI tells the operator every day. |
| **D11** | "`POST /field-sync/scores` 500 for a non-UUID `capturingOfficerId`, **and the edge session carries no officer subject** (four-eyes cannot be checked)" | `physical_test_scores.capturing_officer_id` is `uuid NOT NULL` in all three schemas; `field-sync/adapters/http/sync-scores.controller.ts#92` and `edge-gateway/.../field-sync.controller.ts#115` both treat it as a **bounded string** → Postgres `22P02` → 500. **The second half is false:** `edge_sessions.subject_id` is `NOT NULL` for officer sessions (DB CHECK, `session-store.pg-repository.ts#144`), the officer JWT carries the subject (`shared-auth/src/principal.ts#17` — `subjectId: string`, non-optional), and the edge forwards the credential (`session.upstreamCredential`) so field-sync *sees* `principal.subjectId` | The real defect: **no server-side code binds the record's actor to the authenticated officer**, and the device — not the platform — is the authority for who captured a citizen's physical test. A 500 is the symptom; **a forgeable actor on a legally significant record** is the defect. |

**Extra finding, not in the evaluation:** the NESA academic review hold (`academic_status = PENDING` + `failureCode = NESA_REVIEW_REQUIRED`) is in D10's exact condition. Fixing only the criminal dimension would leave half the amber queue verbless.

---

## 2. The six defects are four failure classes

Fixing six instances is six afternoons of patching that will not survive the next session. Each defect belongs to a class, and each class gets a mechanical guard. **The instance fix is the demo; the guard is the deliverable.**

| Class | Defects | Root cause | Class-killer (the guard that makes the class unrepeatable) |
|---|---|---|---|
| **A. Failure paths that are terminal by accident** | D2, and the missing half of D10 | Redelivery is bounded to ~16 s in-process; the dead-letter topic is a **write-only graveyard** with a manual, stateless operator tool; and where automation gives up there is no human verb either | **Recovery spine:** a durable, capped, backoff re-driver with a per-group circuit breaker — *and* the invariant that **every hold the platform can display has a resolving operation** (checked by a test, not a promise) |
| **B. Two services, no shared vocabulary** | D7 (and D8's new refusals will join it) | Each hop re-states another service's error codes in its own `Set`, by hand, with no check in either direction | **One exported closed vocabulary** + a drift proof asserting the producer's emitted codes and the consumer's handled codes are the **same set** (both directions), plus a rule that an unclassifiable upstream 4xx is **loud**, never "unavailable" |
| **C. Open trust defaults** | D9, D11 | The default bind is the whole network; the default actor is whatever the client wrote in a field | **Secure by default, explicit to open:** loopback unless asked, and opening announces itself; **the authenticated principal is the only actor**, a client-asserted actor that disagrees is refused |
| **D. Mutable evidence** | D8 | One live row per document slot with no revision trail and a review stamp that survives replacement | **Append-only revisions + a review lock:** evidence can be superseded before review, never after, and every upload is a permanent, individually identifiable revision |

---

## 3. Operating laws for this work (non-negotiable)

1. **Red before green.** Every defect gets a failing reproducer *first* — a pure test, a selfcheck assertion, or a journey leg — captured in the PR body. No fix ships without the proof that would have caught it.
2. **Idempotency and monotonicity are the rails.** Any retry, replay or re-drive must land as `NO_CHANGE`, never a regression (ADR-006 / ADR-011 / ADR-025 already say this). The re-driver lives or dies by it.
3. **Closed vocabularies only.** No free text and no third-party code crosses a boundary; a citizen response carries a closed code, never an internal one.
4. **Fail closed on ambiguity, and make drift loud.** An upstream answer we cannot classify is an `ERROR` log plus a closed code with a real meaning for the citizen — never a generic "unavailable" that tells them to retry forever.
5. **Reuse this repo's idioms, don't invent.** The claim+grace+batch+outbox sweeper (`ReannounceStalledClearancesService`), `withAuth({kind})`, `schemaForAgency`, the seven-step edge-contract order (`quality-workflow.md` §4), and a selfcheck registered in `scripts/run-selfchecks.sh`.
6. **Agency-neutral by construction.** Three schemas; compare status enums as **text** (the ADR-017/D1 idiom); a new column lands in all three schemas or not at all.
7. **No new PII surface.** No national IDs, no raw hashes of ID documents (HMAC only, the `clearance_certificate_verifications` idiom), no bodies or upstream messages in logs.
8. **The proof lives where the failure lived**: pure decision → pure test; invariant → selfcheck on real infra; response shape → edge projection test; the citizen's experience → a live sandbox journey.

---

## 4. Phases

One lane ≈ **10 working days**; two lanes from W1, ≈ **6–7 days**. W1's three defects are independent of every decision below, so they start immediately; W2 needs one design (ADR) and none of the owner's answers; W3 needs one owner answer (D8).

```
W0 ground + red baseline       0.5d   ──┬── W1 D7 · D9 · D11        2.0d ──┬── W2 D2 + D10   4.0d ──┬── W3 D8   2.0d ──┬── W4 proof + closure  1.5d
   (kit, ADRs, failing proofs)         │   (three small PRs)               │   (spine + officer verb)        │  (evidence)              │
                                        └───────────────────────────────────┴─────────────────────────────────┴──────────────────────────┘
```

### W0 — Ground and red baseline (0.5 day)

- Write the kit `docs/program/sessions/D0-defect-closure.md` (this plan's executable form: read-first list, per-defect repro, done list).
- Write the three ADRs this plan needs before any code, because each is policy-shaped:
  - **ADR-050 — durable event re-drive** (retry budget, cap, circuit breaker, parking, operator escape);
  - **ADR-051 — vetting-hold resolution** (who may resolve a registry hold, on what evidence, with what audit and what separation of duties; covers D10 *and* D2's terminal state);
  - **ADR-052 — document supersession and review lock** (revisions, HMAC not hash, when the door closes, the officer re-open path).
  - **ADR-053 — bind-host and exposure policy** (loopback default, production requirement, the LAN opt-in and its self-announcement).
  - *Numbers are provisional — the README says renumber at rebase. ADR-040…046 are reserved by other sessions even where the file is not in this checkout yet.*
- Capture the red baseline: six reproducers that **fail today**, each with its exact symptom (status code, DB row, DLQ offset, listening socket). This is the evidence the fix will be judged against, and the raw material for the closure report.
- **Exit gate:** the kit and ADRs are committed; every reproducer is recorded as red with its observed output.

### W1 — Stop the bleeding: D7, D9, D11 (2 days)

Three small, high-certainty, low-coupling PRs. They de-risk the big waves and one of them (D9) has a scheduling dependency on the M2 rehearsal.

#### D7 — one document-door vocabulary, owned in one place

1. **Extract the closed vocabulary** into `@usrp/shared-types` (or a `document-door.contract.ts` beside it): every outcome the forensics upload door can return, as a single exported const/union with its HTTP status and its citizen meaning.
2. Forensics controller maps outcomes **from that constant** (no string literals left in the route). Identity gateway classifies **from that constant**; the hand-written `REFUSALS` `Set` is deleted.
3. Add the missing semantics, not just the missing string:
   - `INVALID_DOCUMENT_TYPE` → `422 UNSUPPORTED_DOCUMENT_TYPE` (the citizen's copy: "that document type is not accepted for this application");
   - `SCANNER_UNAVAILABLE` → `503 SCANNER_UNAVAILABLE` (truthfully retryable, with its own code so the UI can say "try again", not "service down");
   - **any 4xx we cannot classify** → `422 DOCUMENT_REFUSED` + `logError('document_door_contract_drift')`. A citizen is never told to retry a refusal; drift is never silent.
4. Move the per-agency document-type sets (`document-forensics-service/src/domain/agency-documents.ts`) into the shared package so **identity can reject an unknown type before spending a round trip and a ClamAV scan**, and so a third hand-maintained copy can never appear.
5. **Class-killer:** `verify-document-door-contract.ts` (zero infrastructure, joins `verify-edge-contract.ts` at the front of the gate): asserts producer∪consumer code parity in both directions, asserts every code has a distinct citizen meaning, and asserts the identity route's pre-validation set is a superset of the shared set.
- **Proof:** pure test for the mapping table; edge projection test for the response allowlist (no new field leaks); live selfcheck: unknown-but-well-formed `documentType` returns **422, not 503**; ClamAV stopped → **503 `SCANNER_UNAVAILABLE`**, not `UPSTREAM_UNAVAILABLE`.

#### D9 — loopback by default; exposure is an explicit, announced act

1. `shared-config` gains `resolveHttpBindHost()`: `HTTP_BIND_HOST` (validated IP literal) if set; **in production it is required** — boot fails naming the variable (the `assertProductionSecrets` idiom), so a containerised deploy can never silently bind a loopback nobody can reach; otherwise **`127.0.0.1`**.
2. Every entrypoint passes `host` explicitly (12 services + the new worker in W2) — no service inherits a default by accident.
3. `shared-http`'s `0.0.0.0` default is removed so the next service cannot inherit it.
4. Compose (`tier1`/`tier2`) sets `HTTP_BIND_HOST=0.0.0.0` per service — attested by a static selfcheck that walks the yaml.
5. Sandbox: loopback everywhere by default. `SANDBOX_EXPOSE_LAN=1` binds **the edge only** to the LAN, prints the URL and a **banner in `sandbox:full` status**, and is **mutually exclusive with `--real-sms`** (`die`). That combination — a synthetic-population identity door on venue Wi-Fi with real Twilio behind it — is the one accident that would end the programme; it becomes unrepresentable.
- **Class-killer:** `verify-bind-exposure.ts` — enumerates every listening socket for the 13 PIDs and asserts loopback unless the flag is set; asserts compose sets the variable; asserts the `SANDBOX_EXPOSE_LAN` + real-SMS refusal.
- **Proof:** red baseline shows `0.0.0.0:4921`; after the fix only loopback; with the flag, the LAN address *and* the banner; the flag + `--real-sms` exits non-zero.

#### D11 — the authenticated officer is the only actor

1. **Shape (cheap and honest):** `capturingOfficerId` is validated as a UUID at the edge (`400 INVALID_RECORD`) and at field-sync (`400 INVALID_RECORD`). A 500 disappears; nothing is rewritten in the signed payload.
2. **Binding (the real fix):** field-sync's sync use case takes `actorSubject` from the verified `Principal` (already present — no new header, no new session plumbing) and, per record, compares it with the signed `capturingOfficerId`:
   - equal → store **the principal's subject** (the authenticated value, not the asserted one);
   - different → that record is `REJECTED` with closed reason **`OFFICER_MISMATCH`**, nothing stored, an audit entry naming the officer and the device. The batch continues: one bad record must not poison a tablet's morning.
3. `FIELD_SCORE_CAPTURED` keeps carrying the (now authenticated) officer id.
4. **Four-eyes:** state plainly in the ADR and the hand-off that what remains for four-eyes is the **supervisor countersign** on the physical/medical station (an S08/S14 item, needs its own contract), and that phase 0 delivers the precondition — an actor that cannot be forged.
- **Proof:** selfcheck legs — non-UUID → 400 (was 500); mismatched UUID → 200 batch with `REJECTED/OFFICER_MISMATCH` and zero rows written; matching → stored with the principal's subject; audit entry present.

**W1 exit gate:** three PRs merged, `pnpm verify` green on the rebased head, `sandbox:journeys` still 24/24, and each defect's reproducer flips red → green in its PR body.

### W2 — The recovery spine: D2 + D10 (4 days) — *the heart of the work*

These are one design seen from two sides. **D2 is what the machine does when it can retry; D10 is what a human does when the machine has run out of road.** Both must exist, or the citizen's state is a trap either way.

#### W2a — a durable, capped re-driver (D2)

**New:** `services/event-redrive-service` (13th process, ~300 LOC, no business HTTP — `/health`, `/ready`, `/version`) hosting a `DlqRedriver` from `@usrp/shared-events`:

- **Reads** `events.dead-letter` from a durable checkpoint; selects letters by header (`x-usrp-dlq-group`, `-source-topic`, `-reason`, `-attempts`).
- **Classifies in pure code:** `HANDLER_FAILED` → retryable; `UNDECODABLE` / `NON_RETRYABLE` → **never** re-driven (re-publishing a permanently broken event is the storm the 4-core laptop cannot survive). Unit-tested, total, no I/O.
- **Re-publishes byte-exact** to the source topic, reusing the provenance header the existing operator tool already writes.
- **Durable per-letter ledger** — `public_core.event_redrive_ledger` (`rls/0043`): `(source_topic, source_partition, source_offset, group_id)` unique, `attempts`, `first_seen_at`, `next_attempt_at`, `state ∈ {RETRYING, PARKED}`, `last_error_code`, `parked_reason`. Kafka offsets are a cursor, not a scheduler; this table is the schedule, and it survives restarts and a second instance.
- **Backoff with a hard cap** (proposal, configurable): +1 m, +5 m, +15 m, +1 h, +3 h, +6 h → **park** after 6 attempts (~10 h). The sandbox profile compresses this to seconds so the journey is honest and fast.
- **Per-group circuit breaker:** K consecutive failed re-drives for the same `(group, source_topic)` → park that group's letters with `REPEATED_FAILURE` and one `ERROR` + audit. *"Fix the cause first"* (the operator tool's own warning) becomes enforced, not advised.
- **Parking is a signal:** `events.dead-letter-parked` (topic pre-created — broker auto-create is off) + `AUDIT_ENTRY EVENT_REDRIVE_EXHAUSTED`. That audit record is exactly the **"alerting on dead-letter growth"** hook S11a asks for, so we are not building observability twice.
- **Single leader** via a Postgres advisory lock; the worker is safe to run twice.

**Rejected alternatives, and why (they will be asked):**
- *Cron `replay-dead-letters.ts`.* Stateless: every run re-publishes every letter of a group. No backoff, no cap, no dedup — it re-drives a permanently broken event forever, and it cannot tell "already retried" from "new". It stays as the operator's manual last resort, unchanged.
- *Host it in application-service.* A domain service would gain authority over other services' failures. Wrong owner for a platform concern.
- *Extend the in-process retry window (raise `maxHandlerAttempts`).* Longer partitions held hostage, and it still ends in the same graveyard. The window is not the problem; the absence of a schedule is.
- *A separate per-service retry table inside background-vetting.* Redundant: re-driving the parked **event** re-runs the check by construction (`CLEARANCE_CERTIFICATE_SUBMITTED` is byte-exact and the use case is idempotent). One spine, every lane — RIB-by-hash, Irembo, NESA/HEC.

**Proof:** pure policy tests (classify/backoff/cap/circuit); selfcheck against real Kafka with the sandbox behaviour switch (`x-usrp-sandbox-behaviour: 503` then clear → redrive → application leaves `CRIMINAL_CLEARANCE` with no human help); permanent-503 leg → 6 attempts → `PARKED` + audit + topic message; idempotency leg (re-drive twice → identical application state, one audit); breaker leg.

#### W2b — the officer verb for a held application (D10)

One new officer operation, because both held dimensions are the same concept — *"this application is held on evidence a human must judge"* — and a future third dimension (biometric) must not need a new path:

```
POST /v1/applications/vetting-hold
  { applicationId, dimension: 'CRIMINAL' | 'ACADEMIC', decision, reasonCode, notes? }
```

- **CRIMINAL:** `decision ∈ {CLEAR, CONFIRM}` → writes `criminal_clearance_status ∈ {CLEARED, FLAGGED_CONVICTION}`.
- **ACADEMIC:** `decision ∈ {ACCEPT, REJECT}` → writes `academic_status ∈ {ELIGIBLE, INELIGIBLE}` (+ `detail` with the closed reason).
- **Then — the important part — it never hand-rolls a status.** It reads the row's three evidence verdicts under `FOR UPDATE` and calls the **existing pure** `deriveApplicationStatus`, so the early/late rule (REJECTED vs `ADJUDICATION_REVIEW`), the walk-in geography and the monotonic rank all behave exactly as they do for registry evidence. A new status machine here would be a second source of truth.
- **Requires a genuine hold:** `409 NOT_APPLICABLE` unless the row's dimension is actually held (`UNDER_REVIEW` / `NESA_REVIEW_REQUIRED`) — so it can never be used as a general "set the clearance" back door.
- **Idempotent:** re-applying the same decision = `NO_CHANGE`.
- **Lands GREEN → re-emits `APPLICATION_ELIGIBILITY_CLEARED`**, mirroring `adjudicate`'s owner decision D4, so the slot lane treats a human-cleared applicant exactly like an auto-cleared one.
- **Separation of duties:** the officer who resolves a criminal hold may **not** be the officer who accepts the application (`CLEARANCE_REVIEW_EXCLUDES_ACCEPTER`, config-gated, **default ON**). This is the highest-stakes decision in the system; four eyes on it is the national-grade answer. *(Owner-confirmable — see §8.)*
- **Audit:** `VETTING_HOLD_RESOLVED` with dimension, decision, reason code, the closed prior evidence values, reviewer officer id, correlation. No names, no registry payload.
- **Contract in the mandated order** (`quality-workflow.md` §4): service route (+ permission `vetting.hold.resolve`) → `upstream-operations.ts` → `edge-operations.ts` (`session: 'officer'`, CSRF, no retry) → controller → `routes.ts` → `openapi/edge-v1.yaml` → edge projection test. `shared-auth`: new permission, granted to `adjudicator` (and to a new `vetting_officer` role only if the owner asks).
- **Queue read:** the amber queue already carries the reason codes; it gains the dimension so the console can render the right verb (and the list must stay an allowlist read — no new PII).
- **Class-killer:** `verify-hold-coverage.ts` — a table of every `(queueReason → resolving operationId)` the queue can emit, asserted exhaustive against `queueReasons()` and the operation registry. **"No visible hold without a verb" becomes a failing test**, not a review comment.

**Proof:** selfcheck on real infra — seed a criminal-review row and a NESA-review row, resolve both as an officer of the owning agency, assert the derived status, history rows, audit records, the `409` for a non-held row, the `403` for a cross-agency officer, the SoD refusal on the same-officer accept, and idempotency. Edge projection test. Live journey leg (below).

**W2 exit gate:** D2 selfcheck + D10 selfcheck green; `verify-edge-contract` and `verify-hold-coverage` green; the new journey leg passes; no partition held longer than one backoff interval during the fault.

### W3 — Evidence integrity: D8 (2 days)

**Decision proposed: re-upload supersedes before review, and the door closes after it.** (Alternative and its cost in §8 — this is the one defect that is a product/legal call, not an engineering one.)

1. **A revision is an object, not a side effect.** `document_records` (all three schemas, one `rls/0044` migration) gains `revision int NOT NULL DEFAULT 1` and `content_hmac varchar(64)`; a new append-only `document_revisions` table records **every** upload: `document_id`, revision, HMAC, size, media type, lane, score, `uploaded_at`, actor. One row per upload, never updated, never deleted. `document_records` stays "the live slot"; the revision table is **the answer to "which bytes did the officer review?"**
2. **HMAC, not a bare hash.** A SHA-256 of a national ID or a certificate is a confirmation oracle; the key is the service's (`document-envelope`/clearance-HMAC idiom). The audit event carries the revision number and the previous verdict — never the HMAC.
3. **The door closes exactly where review begins:** allowed while the application is at or below document review and the document has no `human_reviewed_at`; otherwise **`409 DOCUMENT_REVIEW_CLOSED`** (a new member of the W1 vocabulary — which is the W1 structural fix paying for itself in the next wave). Rank comparison uses the canonical `APPLICATION_STATUSES` index, not a hand-written list.
4. **Revisions cannot skip or duplicate:** revision assignment happens inside the same `FOR UPDATE` transaction that claims the row, and the store's idempotency key stays `(application_id, minio_object_key)` — a retried upload of identical bytes is still one revision.
5. **The response says what happened, and nothing more:** `{ status: 'UPLOADED', documentId, documentType, revision }`. No lane, no score (the forgery-tuning-oracle rule stands; the leak-guard test covers the new field).
6. **The escape hatch exists in the ADR even if the code waits:** an officer-initiated `document.reopen` (future) is what unlocks a reviewed document, so the citizen is never permanently stuck — the refusal names it.
7. **The stale-stamp bug is closed explicitly:** the update path can no longer run after `human_reviewed_at` exists, so `human_review_decision` can never outlive the bytes it judged. A selfcheck asserts it against a document reviewed CLEAR, then replaced.
- **Proof:** selfcheck — first upload (revision 1) → corrected upload (revision 2, bytes replaced, row updated, two revision rows, distinct HMACs) → officer reviews CLEAR → re-upload is **409**, row unchanged, audit entry; retried identical upload does not create revision 3; upload after `SLOT_ASSIGNED` is 409. Edge projection test for the new `revision` field. Migration verified on all three schemas (the D1 lesson).

**W3 exit gate:** D8 selfcheck green on all three agencies; the `document_records`/`document_revisions` shape identical across `rdf_ops`/`rnp_ops`/`rcs_ops` (asserted, not eyeballed).

### W4 — System proof and closure (1.5 days)

- **One new sandbox journey: `fault-and-recover`** (rides the existing `tools/rehearsal` scenario harness), two legs:
  1. **Machine recovers:** Irembo simulator set to permanent `503` → citizen submits a clearance certificate → the event is dead-lettered → the simulator is cleared → the re-driver re-publishes → the citizen leaves `CRIMINAL_CLEARANCE` and reaches the green lane **with no human action**. Asserts: DLQ letter seen, one ledger row, one audit `EVENT_REDRIVE…`, application advanced.
  2. **Human recovers:** the fault never clears → 6 attempts → `PARKED` + parked-topic message + audit → the officer resolves the hold through the **edge operation** → the application clears to green and the slot lane assigns. Asserts: no stuck state anywhere, and the citizen is never told "verifying" forever.
  This journey is a permanent asset: it is the seed of the S17 failure drift.
- **Closure report** `docs/program/defect-closure-2026-11-01.md`: per defect — root cause, fix, files, the exact proof command and its expected line, residual risk, and what it does **not** fix. The dated evaluation is **not** rewritten; the closure report references it (the milestone ledger in ROADMAP §3.1 is append-only and gets an entry).
- **Hand-offs** (the FE repo consumes contracts, not guesses): one `docs/program/` note per FE-facing change — D10's screen (operation, states, closed reason codes, permission, the SoD refusal), D7's per-code citizen copy, D11's per-record `OFFICER_MISMATCH` sync state, D8's `revision` field and the `DOCUMENT_REVIEW_CLOSED` copy.
- Update `capability-map.md`, the status board, and register every new selfcheck in `scripts/run-selfchecks.sh`.

---

## 5. Work order, PR choreography, and the shared-file discipline

| PR | Content | Shared files touched (commit **separately**, early, small) |
|---|---|---|
| 0 | Kit + ADR-050…053 + red baseline (docs only) | — |
| 1 | **D7** contract constant + mapping + drift proof | `shared-types`, `run-selfchecks.sh` |
| 2 | **D9** bind policy + compose + exposure proof | `shared-http`, `shared-config`, `run-selfchecks.sh`, compose |
| 3 | **D11** actor binding + shape validation | `shared-types` (reason union), `run-selfchecks.sh` |
| 4 | **D2** re-driver package + service + migration + selfcheck | `shared-events`, `rls/0043`, `run-selfchecks.sh`, `turbo.json`, root scripts |
| 5 | **D10** officer verb: service → upstream → edge → controller → routes → openapi → projection test | `shared-auth/permissions`, `edge-operations`, `upstream-operations`, `routes.ts`, `openapi/edge-v1.yaml`, `shared-types`, `run-selfchecks.sh` — **the whole append-only set, in one commit, rebased last** |
| 6 | **D8** revisions + review lock + migration | `shared-types`, `rls/0044`, `run-selfchecks.sh` |
| 7 | Fault-and-recover journey + closure report + hand-offs | `scripts`, `infra/sandbox`, docs |

Rules the programme already learned and this plan obeys: **commit and push early**; the append-only files in PR 5 go in as their own commit and rebase last; migrations are linear — `0043`/`0044` renumber at rebase; **re-prove after every rebase** (`sandbox:journeys` + the new selfchecks).

---

## 6. What this workspace can and cannot verify — read this before approving

**I checked the environment, not assumed it:** no Docker, no pnpm, no `node_modules`, Node **22** (the repo requires **≥24 ≤25**), 3 GB RAM, 2 cores.

- **Cannot run here:** `pnpm verify`, `sandbox:full`, anything live — Postgres, Kafka, MinIO, ClamAV, Twilio. The evaluation itself needed a 7.6 GB laptop for those.
- **Will run here:** pnpm install, `turbo run build typecheck`, `lint:count == 0`, and every **zero-infrastructure** proof — the pure domain tests, `verify-edge-contract`, `verify-edge-hygiene`, the production-guard fakes, edge projection tests, and the new contract/coverage proofs (D7's parity, D10's hold coverage).
- **Consequence for the plan:** each defect ships a **reproducer** (red, exact symptom) plus a **selfcheck** that CI and the owner's machine run. The live green line in each PR body will be produced on the owner's machine for the live-infra legs — I will give the command and the exact expected output line, and I will not claim a proof I did not see. **This is the honest gate:** D2, D8 and D10 are not "done" until their selfchecks pass on real infra.

---

## 7. Definition of done for this effort

1. Six reproducers exist, each red before and green after, recorded with the exact command and observed line.
2. Four structural guards exist and are registered in `scripts/run-selfchecks.sh`: document-door vocabulary parity, bind/exposure, hold coverage, and the cross-schema `document_*` shape.
3. `sandbox:journeys` still 24/24, plus the new `fault-and-recover` journey — all driven through the real edge.
4. No citizen-visible state is terminal without a verb: a hold always has an operation; a transient fault always ends in a result.
5. Lint 0, typecheck clean, build clean on the rebased head; `pnpm verify` green on the owner's machine.
6. Four ADRs accepted, four FE hand-offs written, closure report published, capability map and status board updated.
7. Residual risks stated in writing (starting with: the re-driver cannot fix a *deterministically* broken event — that is what `NON_RETRYABLE` and the parked-topic alarm are for).

---

## 8. Decisions — LOCKED 2026-11-01

| # | Decision | Taken | Recorded in |
|---|---|---|---|
| 1 | **D8 intent** — what a second upload of the same document type means | **Supersede before review; `409 DOCUMENT_REVIEW_CLOSED` after it**, append-only revisions, officer re-open path named in the ADR (not built) | ADR-052 §2 |
| 2 | **D9 exposure** — how the tablet rehearsal reaches the edge | **Loopback by default**; `HTTP_BIND_HOST` required in production; `SANDBOX_EXPOSE_LAN=1` binds the **edge only**, announces itself, and refuses to combine with real SMS | ADR-053 §2 |
| 3 | **D10 separation of duties** | **ON by default** — `CLEARANCE_REVIEW_EXCLUDES_ACCEPTER`, config-gated per agency | ADR-051 §3.4 |
| 4 | **D10 permission** | `vetting.hold.resolve` granted to the existing **`adjudicator`** role; no new role in phase 0 | ADR-051 §2 |
| 5 | **Scope** | Backend + edge contracts and proofs; **four FE hand-offs**; **D1 untouched** | this section |

**Consequence of decision 5, stated once and plainly:** the front-end halves (D10's screen and SoD refusal copy, D11's per-record sync state, D7's per-code citizen copy, D8's `revision` and `DOCUMENT_REVIEW_CLOSED` copy) live in **`e-recruitment-ui`, which is not in this checkout**. Phase 0 can be *backend-complete* and *contract-complete* here; it cannot be **screenshot-complete**. Everything the FE session needs — operation id, permission, request/response, closed codes, states — is written as the W4 hand-off so that session is a pure consume.

**D1's companion guard:** not in scope per decision 5. The cross-schema shape assertion in W3 covers `document_records`/`document_revisions` only; generalising it to "every agency-specific column must exist in all three schemas" is D1's item and stays there.

---

## 9. Risk register (short)

| Risk | Mitigation |
|---|---|
| The re-driver amplifies an outage (retry storm on a 4-core box) | Per-letter cap, exponential backoff, per-group circuit breaker, single leader, publish budget per tick, and a sandbox profile that compresses time only in the sandbox |
| A new column in one schema only (the D1 class) | Every migration touches all three schemas in one file; asserted by the W3 shape selfcheck |
| The bind change breaks the rehearsal or CI | Loopback is the default everywhere; compose is explicit; the exposure flag is proven by its own selfcheck before merge |
| D8's lock is discovered by a citizen mid-process | The refusal is a closed code with citizen copy in the hand-off, and the officer re-open is named in the ADR; watches the sandbox journey |
| A redrive replays an event whose bug is still live | Park-on-repeated-failure; the operator escape remains `replay-dead-letters.ts --execute` |
| Shared append-only files collide with the other lane | Own commit, rebase last, re-prove (§5, `quality-workflow.md` §3.1 lesson) |
