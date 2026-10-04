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
- **Orchestration** (more than one decision, its own failure policy) = controller → `application/` use case → ports. The first one arrives in PR-4 (`submitMyApplication`).

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

The port is async (`check`, `activeBuckets`, `sweep`), so a shared store can sit behind it. PR-1 ships only `InMemoryRateLimiter`, which is the same per-process behaviour as before. PR-4 adds `PgRateLimiter` (`edge_runtime.rate_limit_buckets`, rls/0023) and the production boot refusal for `memory`.
