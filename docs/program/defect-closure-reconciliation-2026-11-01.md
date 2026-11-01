# D0 reconciliation — PR #59 onto `main` after #58

**Date:** 2026-11-01 · **Branch:** `d0/reconcile` (merge of `origin/main` @ `57c2c71` into `origin/arena/74feaf2b-e-recruitment` @ `79b70df`)
**Authority:** this note supersedes the "closed" language in [`defect-closure-2026-11-01.md`](defect-closure-2026-11-01.md) wherever they differ. The dated evaluation is not rewritten.

## 1. Why a reconciliation was needed

PR #59 was written against a `main` that PR #58 then moved. #58 fixed five of the same six defects a different way. #59 was `CONFLICTING` (12 files), which is also why **CI never ran on it** (the `pull_request` workflow does not start on a PR that cannot be merged). So every "proved here" figure in #59 was produced on a head that was not `main` and was never exercised by the live-infrastructure gate.

## 2. Final state per defect

| Defect | Decision | What changed in the merge |
|---|---|---|
| **D7** | #59's shared vocabulary + parity proof replaces #58's single-code fold | `identity` classifies from `@usrp/shared-types`; the hand-written `REFUSALS` set and alias map are gone; `INVALID_DOCUMENT_TYPE → UNSUPPORTED_DOCUMENT_TYPE` is preserved inside the shared table |
| **D8** | Supersede before review, `409 DOCUMENT_REVIEW_CLOSED` after (owner-recommended option) | #58's D14 "re-upload clears the review stamp" is **retired**: the lock makes it unreachable. Its selfcheck (`verify-document-review-replacement`) was removed with it. A document `REJECT` ends the application (terminal), so locking on any human review cannot strand a citizen |
| **D9** | #58's variable name, #59's policy | One variable `USRP_HTTP_BIND_HOST`, one resolver (`@usrp/shared-config`), explicit `host` in all 13 entrypoints, no wildcard default, required in production, `SANDBOX_EXPOSE_LAN` edge-only and refused with `--real-sms`. #58's `shared-http/bind-host.ts` and its test were deleted as superseded |
| **D10** | **One verb.** #58's `adjudicate` with `lane` is kept; #59's second endpoint is removed | Removed: `POST …/vetting-hold`, `vetting.hold.resolve`, nine reason codes, `actions`. Added to `adjudicate`: a durable resolver **set** (`vetting_hold_resolvers[]`, `vetting_hold_resolved_dimensions[]`, rls/0047) so four-eyes holds when two officers resolved two dimensions; accept refuses any member (`ACCEPT_EXCLUDES_CLEARANCE_REVIEWER`, default on); the vetting projection refuses to overwrite a dimension a human already decided |
| **D11** | Both | #58's UUID check (400 not 500) then #59's binding of the signed record to the authenticated officer (`OFFICER_MISMATCH`) |
| **D2** | Both, as layers; **plus a defect fix** | #58's observer escalates to a human within seconds; #59's re-driver recovers the case later with no human. See §3 |

Migrations: `0043`/`0044` are #58's. #59's became **0045** (re-drive ledger + intake cursor), **0046** (document revisions), **0047** (hold resolvers).

## 3. Defects found in #59 by reading its code against `main`

1. **The re-driver could not re-drive anything.** Nothing ever inserted into `event_redrive_ledger`: the worker claimed from a table no code wrote to. The pure policy tests passed, and the only test that would have caught it needs real Kafka and was never run. *Fixed:* an intake pass (`scanNew` over `events.dead-letter` from a durable per-partition cursor, then `intake` in one transaction) runs at the start of every tick.
2. **The attempt cap did not terminate.** A re-driven event that fails again is dead-lettered at a *new* offset, which became a new ledger row with `attempts = 0`, i.e. an endless 1-minute loop. *Fixed:* a letter whose `event_id` the ledger already knows inherits the attempts and `first_seen_at` already spent. Proved by mutation: with inheritance removed the cap proof goes red (37/39); restored, 39/39.
3. **A late machine verdict could overwrite a human decision.** The vetting projection applied any incoming criminal/academic verdict unconditionally, and #59's own stamp was never read there. With a re-driver replaying events hours later, an officer's `FLAGGED` could be flipped by a replayed `CLEARED`. *Fixed* (D10 above).
4. **Four-eyes had a hole.** A single last-writer-wins resolver column let officer A resolve one dimension, officer B another, and A accept. *Fixed* with the resolver set.
5. **Two verbs for one concept** (`adjudicate` lane vs `vetting-hold`). *Fixed* by removing the second.

## 4. Known limits (stated, not hidden)

- The group **circuit breaker** counts failed *republishes*, not handler failures after a successful republish. Termination for a permanently failing event is guaranteed by the per-event cap (6 re-drives), not by the breaker. A handler-level breaker needs a "returned within grace" signal and is a follow-up.
- Each failed re-drive can cause the observer to append another `CLEARANCE_UNVERIFIED` review row (bounded by the cap, ≤ 7). Harmless to state, noisy in the trail; dedupe is a follow-up.
- Structured closed reason codes for a hold resolution are deferred (`notes` stays free text, audit-only).
- The `fault-and-recover` journey is still unbuilt (needs a fenced simulator behaviour-override, S11a).
- Per-resolution proofs for the Postgres transactions (hold stamp, intake, supersession) are **structural or fake-backed** locally. Their live legs run in CI's `Proofs` job and on the owner's machine.

## 5. What was run on this head

- **Gate:** build + typecheck + lint + unit tests, turbo, **92/92 tasks**.
- **Zero-infrastructure proofs:** edge contract **1060** checks, door contract 24, bind exposure 26, actor binding 14, supersession 28, hold resolution 23, redrive policy 39.
- **Real Postgres 16 (throwaway container, not the developer's database):** migrations `0045` and `0047` apply and re-apply cleanly; the stamp expression `adjudicate` uses is idempotent per officer and accumulates two officers; the table refuses an unknown dimension and a half-stamp; `verify-redrive-ledger-live` (11 checks) passes against the real adapter.
- **Not run:** `pnpm verify` end to end, `sandbox:journeys`, any Kafka/MinIO/ClamAV leg, and the Kafka half of intake (`KafkaDeadLetterSource.scanNew`, which uses `consumer.seek` after `run`). CI's `Proofs` job and the owner's machine are the gate for those.
