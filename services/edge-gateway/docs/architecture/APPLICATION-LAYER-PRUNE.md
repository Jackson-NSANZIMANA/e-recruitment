# Why `edge-gateway/src/application/` is not coming back

**Status:** settled · **Decided:** 2026-10-06 · **Commits:** `ee1fab1` (added), `5db81ca` (removed)

A production-readiness commit introduced an application layer into `edge-gateway`
— `SubmitMyApplicationService`, `CitizenSelfService`, `ApplicationDetailService`,
248 lines — and a later commit on the same branch deleted all of it. This note
records why the deletion is correct, so the question is not reopened by anyone
who finds 248 deleted lines in the history and reads them as lost work.

## 1. The code was never reachable

The deletion commit touched **no controller and no route**. The only reference
anywhere in the service was a barrel re-export in `src/index.ts`:

```ts
export * from './application/index.js';   // the single reference, repo-wide
```

No controller imported these classes; no route constructed them; no test
exercised them. They were unreachable from the moment they were written. The
pruning commit is not a behaviour change — it is the removal of a layer that
never executed in any environment.

## 2. The live controllers are strict supersets

Every capability the dead layer described already exists on the request path, in
a stronger form. `SubmitMyApplicationService` against the live
`submitMyApplicationHandler`:

| Behaviour | dead service | live controller |
|---|---|---|
| `EDGE_IDEMPOTENT_REPLAY` audit | yes | yes |
| `EDGE_IDEMPOTENCY_KEY_REUSED` audit | yes | yes |
| Upstream status mapping (201/409/422/404) | yes | yes |
| Rate limiting (`applicantSubmitPerMinute`) | **no** | yes |
| Refuses body `applicantId` / `channel` | **no** | yes |
| Validates the `Idempotency-Key` is one UUID | **no** | yes |
| Emits `Idempotency-Replayed` header | **no** | yes |
| Validates `category` against `ALL_CATEGORIES` | **no** | yes |

`CitizenSelfService` is four one-line forwards to `upstream.call` with no
logic whatsoever; the live controllers do the same calls plus projection and
status handling. Wiring either class in would have **removed** controls.

## 3. One deleted method actively contradicted a security decision

`ApplicationDetailService.getDetail` fetched the record and its status history
with `Promise.all`. The live `getApplicationDetailHandler` is deliberately
**sequential**, and says why:

> The record is fetched FIRST and its 404 short-circuits: if the application is
> not in this officer's agency there is no trail to ask about, and asking anyway
> would make the second call's timing a weak existence oracle.

The parallel version issues the status-history call for applications the officer
has no right to see, and leaks a cross-agency existence oracle through response
timing. Restoring it would regress a hardened control in the system's primary
isolation boundary.

## 4. It contradicted the stated architecture

Per `EDGE-GATEWAY-ARCHITECTURE.md` (this directory) and ADR-021 *The Edge
Tier* (`docs/architecture/adr/ADR-021-edge-tier.md` — note the repo currently
carries two different accepted ADRs numbered 021, in `adr/` and `adrs/`) / ADR-027, edge-gateway is a security
barrier and reverse proxy. Simple brokered operations connect controllers
directly to the `UpstreamGateway` port. A pass-through class per operation is an
abstraction with no behaviour to hold, and — as §2 shows — one that drifts away
from the controller it shadows.

## Verdict

**Do not recover any part of it.** The deletion removed unreachable code that
was simultaneously weaker than the live path and, in one method, unsafe. A
repo-wide orphan sweep (365 TypeScript files) confirms no comparable dead code
survives anywhere else in `src/`; every unimported file is a `selfcheck/` or
`scripts/` entrypoint invoked by the shell runner. This directory was a one-off
anomaly and it is fully cleaned up.
