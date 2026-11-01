# D0 — Defect closure: D2, D7, D8, D9, D10, D11

**Phase 0 · backend lane · branch `fix/d0-defect-closure` (this session: `arena/74feaf2b-e-recruitment`)** · Reserved: **ADR-050** (re-drive), **ADR-051** (hold resolution), **ADR-052** (document supersession), **ADR-053** (bind/exposure); **`rls/0043`** (redrive ledger), **`rls/0044`** (document revisions), **`rls/0045`** (vetting-hold resolver stamp).
**Plan for approval:** [`defect-closure-plan-2026-11-01.md`](../defect-closure-plan-2026-11-01.md) · **Evidence:** [`evaluation-2026-10-29.md`](../evaluation-2026-10-29.md) §2

## Why

The 2026-10-29 evaluation closed Phase 0 with six open defects. They are not six bugs; they are four classes (§2 of the plan):

| Class | Defects | Class-killer proof |
|---|---|---|
| A · failure paths terminal by accident | D2, half of D10 | `verify-hold-coverage.ts` + the re-driver selfcheck |
| B · two services, no shared vocabulary | D7 | `verify-document-door-contract.ts` |
| C · open trust defaults | D9, D11 | `verify-bind-exposure.ts` + the actor-binding selfcheck |
| D · mutable evidence | D8 | the revision/review-lock selfcheck + the cross-schema shape proof |

**The instance fix is the demo; the guard is the deliverable.**

## Delivers

1. **D7 — one document-door vocabulary.** Closed codes in `@usrp/shared-types`; forensics and identity both read it; `INVALID_DOCUMENT_TYPE` → `422 UNSUPPORTED_DOCUMENT_TYPE`; `SCANNER_UNAVAILABLE` → `503 SCANNER_UNAVAILABLE`; an unclassifiable 4xx → `422 DOCUMENT_REFUSED` + `ERROR document_door_contract_drift`. Per-agency document types move to the shared package so identity can pre-validate.
2. **D9 — loopback by default.** `resolveHttpBindHost()`; `HTTP_BIND_HOST` required in production; `shared-http`'s `0.0.0.0` default deleted; compose explicit; `SANDBOX_EXPOSE_LAN=1` (edge only, announced, refused with `--real-sms`).
3. **D11 — the authenticated officer is the only actor.** UUID shape at edge and service (`400`, not `500`); `capturingOfficerId` must equal `principal.subjectId` or that record is `REJECTED / OFFICER_MISMATCH`; the authenticated value is what is stored.
4. **D2 — a durable re-drive.** `services/event-redrive-service` + `DlqRedriver` + `event_redrive_ledger` (`rls/0043`): 6 attempts over ~10 h, per-group circuit breaker, park on `events.dead-letter-parked` + `AUDIT_ENTRY EVENT_REDRIVE_EXHAUSTED`, single leader via advisory lock. `UNDECODABLE`/`NON_RETRYABLE` never re-driven.
5. **D10 — the officer verb.** `POST /v1/applications/vetting-hold` (dimension `CRIMINAL`|`ACADEMIC`), permission `vetting.hold.resolve` (granted to `adjudicator`), evidence write + **existing pure** `deriveApplicationStatus`, re-emits `APPLICATION_ELIGIBILITY_CLEARED` on green, `CLEARANCE_REVIEW_EXCLUDES_ACCEPTER` SoD rule **ON**.
6. **D8 — document supersession.** `revision` + `content_hmac` on `document_records`, append-only `document_revisions` (`rls/0044`), replacement allowed only before human review, `409 DOCUMENT_REVIEW_CLOSED` after it.
7. **The system proof.** `fault-and-recover` sandbox journey (machine recovers; human recovers) + closure report + four front-end hand-offs.

## Read first

`docs/program/README.md` (reserved numbers, shared append-only files) · `quality-workflow.md` §4 (contract order), §8.4 (re-prove after rebase) · ADR-006, ADR-011, ADR-025, ADR-032, ADR-048, ADR-049 · ADR-050…053 (this session) · `docs/program/ROADMAP.md` §8.3.

## Red baseline — reproduce each defect first

Capture the observed output, then fix. These are the lines the closure report must flip.

| # | Reproducer | Red (today) | Green (after) |
|---|---|---|---|
| D2 | `x-usrp-sandbox-behaviour: 503` on the Irembo simulator; submit a clearance certificate; wait 20 s | event on `events.dead-letter`, application stuck at `CRIMINAL_CLEARANCE`, checklist "verifying", nothing re-drives | letter `RETRYING` in the ledger; after the fault clears the application advances with no human action; after 6 attempts `PARKED` + audit |
| D7 | upload a well-formed-but-unknown `documentType` | `503 UPSTREAM_UNAVAILABLE` | `422 UNSUPPORTED_DOCUMENT_TYPE` |
| D7b | stop ClamAV, upload | `503 UPSTREAM_UNAVAILABLE` (indistinguishable) | `503 SCANNER_UNAVAILABLE` |
| D8 | upload a PDF; upload a different PDF of the same type | same `documentId`, one row, no trail | `revision: 2`, two `document_revisions` rows, distinct HMACs |
| D8b | officer reviews CLEAR; upload a replacement | accepted, stamp survives | `409 DOCUMENT_REVIEW_CLOSED`, row unchanged, audit |
| D9 | `ss -ltnp \| grep :4921` after `sandbox:full` | `0.0.0.0:4921` (and 12 more) | `127.0.0.1:4921`; `SANDBOX_EXPOSE_LAN=1` → LAN + banner |
| D10 | row with `criminal_clearance_status = 'UNDER_REVIEW'`; `POST /v1/applications/adjudicate` | `409 NOT_APPLICABLE` | `POST /v1/applications/vetting-hold` → derived status, history, audit |
| D10b | same for NESA (`NESA_REVIEW_REQUIRED`) | no verb in the queue at all | `dimension: 'ACADEMIC'` resolves it |
| D11 | `capturingOfficerId: "officer-1"` in a sync batch | `500` (`22P02`) | `400 INVALID_RECORD` |
| D11b | valid UUID of another officer | stored against that officer | `REJECTED / OFFICER_MISMATCH`, nothing stored, audit |

## Done list

- [x] Six reproducers recorded red, then green, each with its exact command and observed line, in the PR body.
- [x] Every new selfcheck registered in `scripts/run-selfchecks.sh`; `verify-edge-contract.ts` and the hold-coverage proof green at the front of the gate.
- [ ] `sandbox:journeys` still 24/24; `fault-and-recover` passes. — **open.** Journeys need live infra (owner/CI). The `fault-and-recover` journey is **specified, not built**: leg 1 needs a sandbox behaviour-override on the simulator, which is new fenced simulator API and belongs to S11a. The manual two-leg procedure in the closure report §3 closes the risk until then.
- [x] `pnpm build && pnpm typecheck && pnpm lint:count` (lint 0) on the rebased head — 25/25, 45/45, 0, tests 34/34 on `e1c3488`. `pnpm verify` ⏳ owner/CI.
- [x] Migrations `0043`/`0044`/`0045` written; the cross-schema shape proof for `document_records`/`document_revisions` passes on all three schemas (in-session; the *live* apply is CI's `verify-schema-drift`).
- [x] Edge contract: service route → upstream → edge operation → controller → routes → `openapi/edge-v1.yaml` → projection test, in that order, in one commit.
- [x] Four FE hand-offs written: [`handoffs/`](../handoffs/README.md) — D7 per-code copy, D8 `revision` + `DOCUMENT_REVIEW_CLOSED`, D10 screen + SoD refusal, D11 `OFFICER_MISMATCH`.
- [x] Closure report published ([`defect-closure-2026-11-01.md`](../defect-closure-2026-11-01.md)); `capability-map.md`, the status board and the ROADMAP §3.1 ledger row updated.

## Where each defect landed

| Defect | Commit | The one line it flips | Proof (in-session, GREEN) |
|---|---|---|---|
| D7 | `d79325c` | `503 UPSTREAM_UNAVAILABLE` → `422 UNSUPPORTED_DOCUMENT_TYPE` (and `SCANNER_UNAVAILABLE` is its own code) | `verify-document-door-contract.ts` (24) + `verify-edge-contract.ts` (1076) |
| D9 | `017af14` | `0.0.0.0:4921` on 13 processes → `127.0.0.1:4921`, with an announced edge-only LAN opt-in | `verify-bind-exposure.ts` (26) |
| D11 | `3b22bbb` | a forged `capturingOfficerId` stored → `REJECTED / OFFICER_MISMATCH`, per record, audited; `500` → `400` | `verify-actor-binding.ts` (14) |
| D10 | `232ba73` | `409 NOT_APPLICABLE` on an amber hold → `POST …/vetting-hold` with nine reasons, SoD ON | `verify-vetting-hold.ts` (30) + `verify-edge-contract.ts` |
| D8 | `1e5f485` | silent in-place replacement under a `CLEAR` stamp → `revision` + append-only trail, `409 DOCUMENT_REVIEW_CLOSED` after review | `verify-document-supersession.ts` (28) |
| D2 | `e1c3488` | "verifying" for eleven days → six scheduled attempts, then `PARKED` + a signal; a recovered fault advances with no human | `verify-redrive-policy.ts` (32) |

Evidence fixtures for the sandbox journeys: `5f17fed`. Full red→green detail, residual risk and the honest "not run here" list: the closure report, §1–§4.

## D2 note — the doc-drift question, answered in code

The plan suspected ADR-050 described an operator tool that did not exist. It did: `packages/shared-events/scripts/replay-dead-letters.ts` (`pnpm dlq:replay`), with the `x-usrp-replayed-from-dlq` header. The re-driver writes the **same** header, so a human re-drive and an automatic one are indistinguishable downstream, and the ADR needs no amendment — only the addition that the ledger, not the script, is the schedule.

## Environment note (read before quoting a proof)

This session's workspace has **no Docker, no pnpm, Node 22 (repo requires ≥24 ≤25), 3 GB**. Live-infra legs (`pnpm verify`, `sandbox:full`, Twilio) run on the owner's machine or CI. In-session gate: install pnpm, `turbo run build typecheck`, `lint:count == 0`, and every zero-infrastructure proof (pure domain tests, `verify-edge-contract`, `verify-edge-hygiene`, production-guard fakes, edge projection tests, the new contract/coverage proofs). **No proof is claimed that was not observed.**

## Owns

- `services/event-redrive-service/**` (new)
- `packages/shared-events/**` (re-driver; append-only shared)
- `packages/shared-http/**`, `packages/shared-config/**` (bind host)
- `packages/shared-auth/src/permissions.ts` (one permission — append-only shared)
- `packages/shared-types/**` (closed vocabularies — append-only shared)
- `services/edge-gateway/**`, `services/identity-service/**`, `services/document-forensics-service/**`, `services/field-sync-service/**`, `services/background-vetting-service/**`, `services/application-service/**`
- `packages/shared-database/src/rls/0043…0045`
- `infrastructure/{sandbox,docker}/**`, `scripts/run-selfchecks.sh`
