# Edge gateway architecture (after homogenisation)

This replaces the three stale "COMPLETE / FINAL / COMPLETION" documents. It describes what the code does, and `selfcheck/verify-edge-hygiene.ts` fails if the code stops matching it.

## One of everything

| Concern | The single home |
|---|---|
| Browser operation registry | `src/domain/edge-operations.ts` |
| Upstream allowlist | `src/domain/upstream-operations.ts` |
| Dependency bundle (`EdgeDeps`) | `src/adapters/http/guards.ts`, typed on ports only |
| Audit / stats / fault sink | `src/adapters/audit-logger.adapter.ts` (recursive redaction on every channel) |
| Token primitives (CSRF, handle) | `src/crypto/tokens.ts` |
| Composition | `src/index.ts` (the only file that names concrete adapters) |

## Layering rule

```
adapters/http/*  ─┐
adapters/*.ts    ─┼─► ports/*  ─► domain/*      crypto/* (leaf, used by both adapter sides)
application/*    ─┘
```

- A driven adapter (`adapters/*.ts`) never imports `adapters/http/*`.
- `domain/` and `crypto/` import nothing outward.
- **Simple brokered operation** = controller → `UpstreamGateway` port. No pass-through "service".
- **Orchestration** (more than one decision, its own failure policy) = controller → `application/` use case → ports. The first one arrived in PR-4 (`submitMyApplication`).

The four former application services (`OfficerAuthService`, `ApplicantAuthService`, `SessionManagementService`, `UpstreamProxyService`) were deleted, not wired: no controller called them, and `ApplicantAuthService` read `sessionHandle` where upstream returns `sessionToken` and dropped `channel=WEB`. Wiring them in would have broken citizen login.

## Logging

Every line written after boot goes through `AuditLogger`:

- `log()` boundary events (closed vocabulary `EdgeAuditAction`)
- `stats()` aggregate counters
- `fault()` operational faults (closed vocabulary `EdgeFaultEvent`); the error is reduced to `{ name, code }`, never its message or stack

Only `main.ts` start/stop/startup-failure lines write to the console directly.

## Session refresh

`rotate()` returns `RotatedSession | null`: null when the row was revoked between resolve and rotate (the route answers 401 with a cleared jar), otherwise the new secrets **and the deadlines the UPDATE persisted**. The refresh body is built from those, so the JSON, the cookie and the row describe the same session.

## Rate limiting

The port is async (`check`, `activeBuckets`, `sweep`), so a shared store can sit behind it. PR-1 shipped only `InMemoryRateLimiter`, which was the same per-process behaviour as before. PR-4 landed `PgRateLimiter` — the shared store — as `adapters/rate-limiter.pg.ts` over `public_core.edge_rate_limit_buckets` (**rls/0024**, sole grantee `usrp_edge_gateway`, keyed-hash bucket keys, `FORCE ROW LEVEL SECURITY`), plus the production boot refusal for `memory` (`assertRateLimitStoreAllowed`: under `NODE_ENV=production` the boot throws rather than silently per-process). One atomic `INSERT … ON CONFLICT DO UPDATE` (resetting the window when it has aged past a minute) both increments and decides, so concurrent replicas cannot lose increments; any store fault fails closed as `RateLimiterUnavailableError` (the submit seam's 503). Proven by `selfcheck/verify-rate-limit-store.ts`: two instances over one database share one window, 24 concurrent attempts at a limit of 10 pass exactly 10 with all 24 counted, aged windows reset, and the sweeper removes what it should.

The first consumer is the citizen submit operation: `submitMyApplication` rate-limits per **applicant session** (`sessionBucketKey`, `EDGE_APPLICANT_SUBMIT_RATE_LIMIT_PER_MINUTE`, default 5) *before* the write is attempted, so the ledger — not the limiter — is the only thing that can be replayed.
