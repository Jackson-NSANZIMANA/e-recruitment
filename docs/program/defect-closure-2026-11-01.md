# Defect closure — 2026-10-29 evaluation, §2 (D2, D7, D8, D9, D10, D11)

**Status:** closed in code and proven by the listed commands · **Date:** 2026-11-01 · **Branch:** `arena/74feaf2b-e-recruitment`
**Input (not rewritten):** [`evaluation-2026-10-29.md`](evaluation-2026-10-29.md) §2 · **Plan:** [`defect-closure-plan-2026-11-01.md`](defect-closure-plan-2026-11-01.md) · **Session record:** [`sessions/D0-defect-closure.md`](sessions/D0-defect-closure.md)
**Front end:** the four contracts are handed off in [`handoffs/`](handoffs/README.md).

This report is the counterpart to the evaluation, not a replacement for it. The evaluation stays as it was written; this file says what changed, how it is proven, and what is still open.

---

## 0. How to read the evidence column

Every row below was **executed here** unless it is explicitly marked *owner/CI*. The workspace has no Docker, no Postgres, no Kafka and no ClamAV; a claim I could not run is not made as if I had. Reproduce the in-session rows with:

```bash
set -a; eval "$(grep -E '^export ' scripts/run-selfchecks.sh)"; set +a   # env some proofs need
npx tsx <selfcheck path>                                                  # any single proof
pnpm exec turbo run build typecheck && bash scripts/count-lint.sh && pnpm exec turbo run test --continue
```

Green gate on `e1c3488` (the head this report describes): **build 25/25 · typecheck 45/45 · lint 0 · unit tests 34/34**.

---

## 1. Per defect

### D2 — a dead letter had no schedule

**Root cause.** ADR-025 made a failed event durable, then nothing picked it up. `maxHandlerAttempts` is six attempts inside ~15.5 s — a *window*, not a schedule — and the operator tool `packages/shared-events/scripts/replay-dead-letters.ts` is stateless: re-running it after an outage re-publishes letters that already succeeded. So the event was durable and its **state** was not. A clearance whose Irembo lookup met a `429` stopped at `CRIMINAL_CLEARANCE` with a checklist reading "we are verifying" — observed for eleven days in the evaluation.

**Fix.** A ledger **is** the schedule, and a worker reads it.
- `public_core.event_redrive_ledger` (`rls/0043`): one row per letter, `UNIQUE (source_topic, source_partition, source_offset, group_id)`, states `RETRYING | REDRIVEN | PARKED`, rows never deleted. No payload is stored — the bytes stay on `events.dead-letter`.
- `decideRedrive` (`packages/shared-events/src/redrive.ts`), pure and total: `1m, 5m, 15m, 1h, 3h, 6h`, then `PARK(ATTEMPTS_EXHAUSTED)`; `UNDECODABLE`/`NON_RETRYABLE` park immediately; a per-`(group, topic)` breaker parks after 3 consecutive failures, because a deterministically broken handler must not become a retry furnace.
- `services/event-redrive-service` (the 13th process): `/health`, `/ready`, `/version` and nothing else, no business decision, single leader via `pg_try_advisory_lock(4050001)` (released by the engine if it dies — no lease table, no clock skew). Kafka is **required**: a re-driver with no broker re-drives nothing, and a green process moving nothing is worse than one that refuses to boot.
- Re-drive is **byte-exact** to the original topic with `x-usrp-replayed-from-dlq: true` — the same header the operator tool writes, so a human re-drive and an automatic one are indistinguishable downstream. A letter gone from retention parks (`LETTER_GONE`); a transport failure reschedules and counts against the breaker.
- Parking emits on `events.dead-letter-parked` (pre-created in sandbox and tier2, `retention.ms=-1`; auto-create is off by design).

**Proof.** `services/event-redrive-service/selfcheck/verify-redrive-policy.ts` — **32 assertions**, zero infrastructure (the policy swept over every status × attempts × streak × timestamp combination, plus the real use case against a fake ledger, a fake graveyard, a fake publisher and an injected clock).
RED rehearsal: remove the attempt cap and the breaker from the policy → **25 passed, 7 failed** (including "36 combinations incoherent"). GREEN: **32/32**.

**Residual risk.** The re-driver cannot fix a *deterministically* broken event — that is what `NON_RETRYABLE` and the parked-topic alarm are for, and the alarm belongs to S11a. A parked letter still needs a human; the citizen path for that human is D10.

---

### D7 — two services, two vocabularies, and a permanent fault reported as transient

**Root cause.** Forensics and identity each hand-wrote the set of codes the upload door can answer. They disagreed. `INVALID_DOCUMENT_TYPE` — a citizen's typo, permanent, unfixable by retrying — reached the portal as `503 UPSTREAM_UNAVAILABLE`. Nothing compared the two lists, so it would never have been found by reading either one.

**Fix.** One vocabulary in `@usrp/shared-types` (`DOCUMENT_DOOR_CODES`: status **and** the actor who must act, per code), read by both services; `INVALID_DOCUMENT_TYPE → 422 UNSUPPORTED_DOCUMENT_TYPE`; `SCANNER_UNAVAILABLE → 503 SCANNER_UNAVAILABLE` (distinguishable from "upstream is down"); an unclassifiable 4xx → `422 DOCUMENT_REFUSED` and `ERROR document_door_contract_drift`. Per-agency document types moved into the shared package so the portal can pre-filter instead of discovering the rule by rejection.

**Proof.** `packages/shared-types/selfcheck/verify-document-door-contract.ts` — every producer code present in the vocabulary, every vocabulary code reachable, no service-local literal left. `verify-edge-contract.ts` (**1076 checks**) keeps the edge projection in step.
**Residual risk.** `DOCUMENT_REFUSED` is a lossy catch-all: it keeps an unmodelled refusal from being reported as an outage, but it cannot say *which* refusal. If it ever appears in the console, that is our bug and the log line says so.

---

### D8 — mutable evidence: the bytes could change after the stamp

**Root cause.** A second upload of the same document type `UPDATE`d the slot in place: same `documentId`, no revision, `human_reviewed_*` untouched. A citizen could get a certificate reviewed `CLEAR` and then replace the file under the platform's own approval stamp. The stamp outlived the bytes it judged.

**Fix** (ADR-052).
- `revision` and a keyed `content_hmac` on `document_records`; append-only `document_revisions` (`rls/0044`), one row per revision with its own `content_hmac`; the object key stays stable per slot (the bytes are replaced — the trail, not the bucket, is the record of what was judged).
- `decideSupersession` (`services/document-forensics-service/src/domain/supersession.ts`) is the **only** branch, run inside the `FOR UPDATE` transaction: stamped → `CLOSED_HUMAN_REVIEW`; case advanced past `DOCUMENT_REVIEW_AMBER` → `CLOSED_CASE_ADVANCED`; identical bytes → `RETRY` (a flaky network must not inflate a count a reviewer reads as "replaced three times"); otherwise `SUPERSEDE` with `revision + 1`. The rank comes from the canonical `APPLICATION_STATUSES`, so it cannot drift when a status is inserted.
- Replacement is refused with `409 DOCUMENT_REVIEW_CLOSED` and a closed reason (`HUMAN_REVIEWED` | `CASE_ADVANCED`). The update path can no longer execute once `human_reviewed_at` exists, so `human_review_decision` can never outlive its bytes.
- `201` carries `revision` and **nothing else** — no lane, no score, no flags: a verdict handed to the uploader is a forgery-tuning oracle.
- Content identity is a **keyed HMAC**, not a plain digest: a SHA-256 of a passport page is a confirmation oracle for anyone holding the file.

**Proof.** `services/document-forensics-service/selfcheck/verify-document-supersession.ts` — **28 assertions**, including the cross-schema shape check on all three agency schemas (the D1 lesson: a migration proven on one schema is proven on none), reviewed-then-replaced → `409`, retried identical upload → no revision 3, and `SLOT_ASSIGNED` upload → `409`.
**Not shipped:** the officer `document.reopen` verb. ADR-052 §3.6 records it as the escape hatch; until it exists the citizen copy sends a human, not a button.
**Residual risk.** `CASE_ADVANCED` is defined by status rank. If a future status is inserted *above* review but semantically still pre-review, the rule is wrong — and `supersession.ts` will need one line, not a review of the codebase. That is the intended trade.

---

### D9 — exposure was the default, silent, and everywhere

**Root cause (as reported):** "the sandbox edge listens on `0.0.0.0`". **Verified in code:** `packages/shared-http/src/server.ts` had `host = '0.0.0.0'` as a *default*, and the edge never passed one — so **all 13 processes** were LAN-reachable, not only the edge. But "loopback only" is the wrong fix: M2 drives the system from Galaxy Tab A7–A10 over a venue network, and a blanket loopback bind would make the rehearsal impossible and be silently reverted by whoever hit it. **The defect was that exposure was the default and unannounced.**

**Fix** (ADR-053). `resolveHttpBindHost()`: loopback unless something says otherwise; `HTTP_BIND_HOST` is required in production; the `0.0.0.0` default in `shared-http` is deleted; compose passes it explicitly. `SANDBOX_EXPOSE_LAN=1` is an announced, edge-only opt-in that binds the machine's **LAN IPv4** (not `0.0.0.0`), prints the URL and the `sandbox:full status` banner, and is mutually exclusive with `--real-sms` — the launcher `die`s. The refusal lives in both the launcher and `full.sh`, so neither path can bypass it.

**Proof.** `packages/shared-config/selfcheck/verify-bind-exposure.ts` — **26 assertions**: every service resolves loopback by default, production without `HTTP_BIND_HOST` throws, the LAN opt-in binds a specific address (never the wildcard), the banner is emitted, and `--real-sms` + LAN is refused.
**Residual risk.** A phone on the venue network still needs the LAN opt-in — the pilot's documented path, and now a visible one. Nothing in the *production* profile can opt in.

---

### D10 — a queue of work that could not be done

**Root cause.** The amber queue listed applications held on a criminal-clearance review (`criminal_clearance_status = 'UNDER_REVIEW'`) or a NESA review (`NESA_REVIEW_REQUIRED`). **No operation resolved either.** The only verbs were medical/final/adjudicate, and `adjudicate` answered `409 NOT_APPLICABLE` on those rows. The platform showed an officer work and then refused it.

**Fix** (ADR-051).
- `POST /v1/applications/vetting-hold` (edge: `/edge/v1/applications/vetting-hold`, permission `vetting.hold.resolve`, **granted to the existing `adjudicator` role only** — no new role) with `dimension: CRIMINAL | ACADEMIC` and a **closed reason set** in `@usrp/shared-types`. The reason *is* the verdict: each names its dimension, its decision and the column value it writes, so a reason/decision mismatch is `422` at the ingress and again at the service.
- The write goes through the **existing pure** `deriveApplicationStatus` — the officer verb does not invent a status; it records evidence and lets the one lifecycle function decide. Green re-emits `APPLICATION_ELIGIBILITY_CLEARED` so the slot lane runs; a hard fail routes to `ADJUDICATION_REVIEW`/`REJECTED` by the ordinary rules.
- An **audit entry** per resolution (`VETTING_HOLD_RESOLVED`, with the reason and assertion), plus `vetting_hold_resolved_by/at/dimension` (`rls/0045`).
- **Separation of duties, default ON** (`CLEARANCE_REVIEW_EXCLUDES_ACCEPTER`): the officer who resolved the hold may not accept that application — `403 SEPARATION_OF_DUTIES / ACCEPT_EXCLUDES_CLEARANCE_REVIEWER`. This is the highest-stakes decision in the system; four eyes is the national-grade answer.
- Every queue row now carries a closed `actions` array (`ADJUDICATE`, `RESOLVE_VETTING_HOLD`) so the console renders a verb per action instead of inferring one from `status` + `reasons` — that inference is exactly how "Adjudicate" came to be offered where only a resolution could work.

**Proof.** `services/application-service/selfcheck/verify-vetting-hold.ts` — **30 assertions**: reason→column mapping for all nine reasons, dimension/reason mismatch refused, both dimensions resolve, `NOT_HELD` after resolution, `statusChanged` honesty on a late hold, the SoD refusal on both verbs, and the queue's `actions` for every hold shape. `verify-edge-contract.ts` (**1076 checks**) covers the new operation end to end: registry → upstream catalogue → route → controller → `openapi/edge-v1.yaml` → projection test, with `x-usrp-permission` and `x-usrp-outcomes: {409: [NOT_HELD, SEPARATION_OF_DUTIES]}` declared.

**Residual risk.** SoD is config-gated, so an operator can turn it off — that is deliberate (a one-officer agency has no second officer) and must be a recorded decision, not a default. The reason set is closed and complete *for the statuses the platform models today*; a new hold type needs a new reason, which is a one-line addition to a table that a test sweeps.

---

### D11 — the device decided who captured a citizen's test

**Root cause (as reported):** a non-UUID `capturingOfficerId` produced a `500` (`22P02`). **Verified in code, and worse:** the reported 500 was the *symptom*. The claim also asserted that "the edge session carries no officer subject" — **false**: `session.principal.subjectId` was there and ignored. The platform stored whatever officer the **tablet** named, so any authenticated officer could file a score as any other officer simply by editing the payload.

**Fix.** The authenticated principal is the only actor. UUID-shape validation at the edge **and** in the service → `400 INVALID_RECORD`, not `500`. A `capturingOfficerId` that disagrees with `principal.subjectId` is `REJECTED / OFFICER_MISMATCH` **per record** — the record is not stored, an audit entry is written, and the rest of the batch still lands (a whole-batch rejection on one bad claim would have been its own outage). `FieldScoreRejectReason` lives in `@usrp/shared-types` so tablet and service cannot disagree about the closed set.

**Proof.** `services/field-sync-service/selfcheck/verify-actor-binding.ts` — **14 assertions**: shape rejection at both layers, `OFFICER_MISMATCH` per record, the authenticated id is what is stored (never the claim), the batch survives a bad record.
**Not shipped:** the supervisor countersign on the physical/medical station (S08/S14). D11 delivers the **precondition** — an actor that cannot be forged — not the countersign.

---

## 2. What the four structural guards now prevent

| Class | Guard | Fails when |
|---|---|---|
| A · failure paths terminal by accident | `verify-redrive-policy.ts` (+ `verify-dead-letter.ts`) | any letter can retry without a cap, or park without a signal |
| B · two services, no shared vocabulary | `verify-document-door-contract.ts` (+ `verify-edge-contract.ts`) | a producer answers a code the vocabulary does not define, or the edge loses the projection |
| C · open trust defaults | `verify-bind-exposure.ts` + `verify-actor-binding.ts` | a process exposes itself by default, or an actor is taken from the request |
| D · mutable evidence | `verify-document-supersession.ts` | bytes can change after a stamp, or a revision is not recorded |

Plus `verify-vetting-hold.ts` for the "no citizen-visible state is terminal without a verb" rule.

---

## 3. The system proof — specified, deliberately not written

The plan (§W4) asks for a `fault-and-recover` sandbox journey with two legs:
1. **machine recovers** — Irembo simulator at permanent `503` → certificate submitted → dead-lettered → fault cleared → the re-driver republishes with no human action → the application leaves `CRIMINAL_CLEARANCE`;
2. **human recovers** — the fault never clears → six attempts → `PARKED` + parked-topic message + audit → an officer resolves the hold through the edge → the slot lane assigns.

**Status: not built, and I am not going to ship an unrun harness that looks like a proof.** The blocker is concrete and worth recording, because it is a design decision the owner should see:

- Leg 2 is *almost* expressible today: the sandbox catalogue already carries per-persona, per-authority behaviour (`citizen.behaviour[authority]`), so a drill persona with `irembo-certificates: 'maintenance'` produces exactly the permanent fault leg 2 needs.
- Leg 1 needs the fault to **stop**. The simulator's behaviour is decided per request from (a) the persona catalogue and (b) the caller's `x-usrp-sandbox-behaviour` header — and the caller that matters is `background-vetting-service`, not the journey. There is no control surface that flips an authority's behaviour for a window, so "the fault clears" cannot be driven from the harness.
- Adding that control surface is **new simulator API**, and every simulator surface is fenced (ADR-047, `verify-simulator-fence.ts`): a behaviour override must be sandbox-only, authenticated, time-bounded and audited, or it becomes a way to make a sandbox "pass". That is a session of its own, not a footnote in a closure.

What exists instead, and what it covers: D2's worker is proven against a fake ledger/graveyard/publisher with an injected clock (32 assertions), D10's resolution is proven against the real service rules (30), and the slot lane has its own long-standing proof (`verify-slot-assignment.ts`). What is **not** proven end to end is the composition — letter → ledger → worker → republish → consumer → status — under a real Kafka and a real Postgres.

**Owner/CI action, in order:**
1. `pnpm verify` and `pnpm sandbox:journeys` (must still be 24/24) on this branch — this validates that nothing regressed and that `events.dead-letter-parked` exists in both compose tiers.
2. Manually: set `x-usrp-sandbox-behaviour: maintenance` on the Irembo simulator for the *persona* used, submit a certificate, watch `public_core.event_redrive_ledger` (one row, `RETRYING`, `attempts` climbing on the 1m/5m/15m schedule), then restart the simulator without the behaviour and watch the application advance. That is leg 1 by hand, and it is enough to close the risk.
3. Leg 2 by hand: leave the fault up for ~10 h (or compress `REDRIVE_DELAYS_MS` in a sandbox run) → `PARKED` + `events.dead-letter-parked` → resolve the hold from the console → the slot lane assigns.

The journey then becomes worth automating as part of **S11a** (observability and recovery), whose alerting owns the parked signal anyway — with the behaviour-control endpoint designed and fenced there.

## 4. Residual risks, in writing

1. **A deterministically broken event is still a human's problem.** The re-driver cannot fix it; `NON_RETRYABLE` + the parked-topic alarm (S11a, not yet built) are the answer, and until the alarm exists, parking is a row in a table.
2. **Parked is not urgent.** Nothing pages anyone on `PARKED` yet. The signal exists; the responder does not.
3. **D8's status rank is a policy, not a law.** `CASE_ADVANCED` is defined by `APPLICATION_STATUSES` order; inserting a status above review that is semantically pre-review silently changes the rule.
4. **`DOCUMENT_REVIEW_CLOSED` has no citizen escape hatch in code.** Until `document.reopen` ships, a reviewed document is only replaceable through a human — which the copy says.
5. **Separation of duties is switchable.** By design, because a one-officer agency exists; a production profile that leaves it off should be a finding.
6. **Front end is not in this checkout.** Four contracts are handed off; nothing in `e-recruitment-ui` is proven by this report.
7. **Live infra legs were not executed here** (§0). `pnpm verify`, `sandbox:full`, `sandbox:journeys` and the rehearsal are the owner's/CI's gate, and the milestone-ledger entry must cite that run, not this workspace.

---

## 5. Checkout

| # | Definition of done (plan §7) | State |
|---|---|---|
| 1 | Six reproducers exist, red before, green after, with the exact command | ✅ per-defect proofs above; the red lines are reproduced by the RED rehearsals recorded in each selfcheck's companion run |
| 2 | Four structural guards registered in `scripts/run-selfchecks.sh` | ✅ all six new proofs registered |
| 3 | `sandbox:journeys` 24/24 + `fault-and-recover` | ⏳ **not met** — journeys are owner/CI; `fault-and-recover` is specified but not built (§3 says why, and what to run by hand instead) |
| 4 | No citizen-visible state is terminal without a verb | ✅ D2 (park → officer verb, D10) and D10 (every hold has an operation) |
| 5 | Lint 0, typecheck clean, build clean | ✅ 0 · 45/45 · 25/25 on `e1c3488`; `pnpm verify` ⏳ owner/CI |
| 6 | Four ADRs, four hand-offs, closure report, capability map, status board | ✅ ADR-050…053 · `handoffs/` · this file · updated |
| 7 | Residual risks in writing | ✅ §4 |
