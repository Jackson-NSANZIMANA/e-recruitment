# Slice — the edge tier becomes real (`services/edge-gateway`)

**ADR:** [ADR-021 — The Edge Tier](./adr/ADR-021-edge-tier.md)
**Proof:** `services/edge-gateway/selfcheck/verify-edge-slice.ts`
**Deviations from `openapi/edge-v1.yaml`:** [`services/edge-gateway/docs/CONTRACT-DEVIATIONS.md`](../../services/edge-gateway/docs/CONTRACT-DEVIATIONS.md)

---

## 1. What was broken

The frontend monorepo had been written since 2026-08-06 against a tier that did
not exist. Its shipped `@usrp/api-client` points at
`https://bff.rdf.usrp.gov.rw/api/v1` and at `/auth/login`, `/auth/me`,
`/auth/logout` — four endpoints no service serves — and the four BFFs its
architecture doc asserted were never built.

This was not a missing feature. It was a **missing architectural tier**, and it
is why the applicant portal could not verify a National ID, file an application
or upload a document: all three upstream operations are `reach:
service-internal`, and a browser cannot legitimately reach any of them.

ADR-021 decided the shape on 2026-09-04. What existed before this slice was the
ADR and an OpenAPI document — `services/edge-gateway/` contained `openapi/` and
no source at all.

## 2. What now exists

One service serving **all** browser traffic at `/edge/v1/**`: 23 operations,
hexagonal, on the zero-dependency `@usrp/shared-http` substrate (ADR-005), with a
Postgres-backed session store.

```
src/
├── config.ts                      runtime + db + session + cors + auth + upstreams + limits
├── domain/                        EdgeSession (holds the credential) vs SessionView (cannot)
├── ports/                         EdgeSessionStore · Iam/Identity/Application gateways
├── application/session.service.ts the credential -> session mapping; the TTL clamp
├── adapters/store/               Pg (production) · in-memory (proofs)
├── adapters/upstream/            one HTTP client + three gateways, allowlist projection
└── adapters/http/                paths · cookies · csrf · rate-limit · guard · 8 controllers
```

`rls/0019_edge_sessions.sql` adds `public_core.edge_sessions` and the
least-privilege `usrp_edge_session_writer` role.

## 3. The five properties that carry the design

**1. The browser holds a handle, never a credential.** 32 CSPRNG bytes,
base64url, in an `httpOnly` `Secure` `SameSite=Strict` `__Host-` cookie. The
officer's Ed25519 JWT and the citizen's opaque token stay server-side —
`SessionView` has no field for either. Because officer JWTs are non-revocable
until expiry (ADR-016), destroying the handle is the **only** officer revocation
that exists.

**2. Agency is server-authoritative by construction.** No path segment, query
parameter or body property anywhere carries an agency; it comes from the signed
token claims. The database goes further: a `CHECK` in 0019 makes "an applicant
session has no agency" a constraint rather than a convention.

**3. CSRF is double-submit, bound to the session, and fails loudly.** With a
session the `x-csrf-token` header is compared against the token **stored with
the session**, which defeats cookie injection — the standard weakness of plain
double-submit. Missing or mismatched is always 403.

**4. The edge refuses to leak, structurally.** Upstream bodies are `unknown`
until checked, and every gateway method rebuilds an explicit allowlisted value.
Three things upstream legitimately returns are dropped at the boundary:
`lockedByAgency` on the ADR-014 accept conflict, `qrInvitationCode` on a walk-in
registration, and `applicantId` from identity verification. Bare 404s stay bare;
one credential rejection covers every credential problem; no forensic lane,
score or flag reaches a citizen-facing response.

**5. Retry is a property of the operation.** `retryOnG2G` is read from the
registry inside the upstream client, so a call site cannot opt a write into
retrying. It is `false` for every write that changes application state.

## 4. Two things the implementation found

**The 12-hour session ceiling is not achievable.** The credentials the edge holds
live one hour and thirty minutes, and neither can be re-issued without the human
re-authenticating. The edge reports `min(configured, credential expiry)` rather
than promising a ceiling it cannot honour.

**The draft OpenAPI was wrong in eight places** — most sharply,
`walk-in/register` described `{ nationalId, postCode }` for a controller that
takes `{ applicantId, category, ... }`, and `verifyIdentity` promised a
`fullName` no upstream read produces. Every one is recorded, with the resolution,
in `CONTRACT-DEVIATIONS.md`. The document's own `pending-controller-read`
markers are what made this checkable — they worked.

## 5. Proof

```bash
pnpm infra:up:tier1
pnpm bootstrap:db                       # must include rls/0019 — see residual 2
pnpm typecheck
pnpm --filter @usrp/edge-gateway selfcheck
```

A real socket, a real cookie jar, stub upstreams, and the **real** Postgres
store. Stubs are deliberate: every assertion is a property of *this* tier, and
three live services would test them instead. It proves, among others: the JWT
appears in no `Set-Cookie`; a wrong password and a malformed field are
byte-identical; a known and an unknown National ID are byte-identical on OTP
request; the accept-lock 409 does not contain `RNP` when upstream said `RNP`; an
RDF session produces `fitnessStatus` and an RNP session `certVerdict` from the
same request body; a retryable read retries exactly once and a write never does;
a matching cookie+header pair still fails when it is not the session's token; an
upstream 401 clears the cookies and reports `reason: revoked`; the stored row
contains neither the handle nor the credential; and the database refuses an
agency on a citizen session.

## 6. Residuals — read this before calling the tier done

1. **CI has not run this branch.** `pnpm typecheck` and the selfcheck were
   written against the read source of every dependency but have not been executed
   here; the gate is the arbiter.
2. **`pnpm bootstrap:db` does not yet apply `rls/0019`.** One `apply_sql` line in
   `scripts/bootstrap-db.sh`, after the 0018 step. Without it the edge cannot
   store a session.
3. **The proof is not in the gate yet.** One `run_ts` line in
   `scripts/run-selfchecks.sh`.
4. **New env vars are not in `.env.example` or `turbo.json`:**
   `IDENTITY_SERVICE_BASE_URL`, `PORT_EDGE_GATEWAY`, `EDGE_UPSTREAM_TIMEOUT_MS`,
   the three `EDGE_RATE_LIMIT_*`, `EDGE_CLIENT_IP_HEADER`.
5. **`openapi/edge-v1.yaml` still carries the draft bodies.** Update it from
   `CONTRACT-DEVIATIONS.md` and drop the `pending-controller-read` markers.
6. **Export `ME_WITHDRAW_PATH` from identity-service** and delete the edge's
   composed constant.
7. **The rate limiter is per process.** With N replicas the budget is N×. Kong
   can enforce a global ceiling today; a shared counter is the follow-on.
8. **No end-to-end pass with live upstreams yet.** This slice proves the edge;
   composing it into the platform pipeline proof is the next increment.
9. **Officer display name in the status trail.** The Procedural Justice record
   carries the actor *kind*, not a name, because no upstream read exposes one.
10. **The edge imports three service packages for their PATH CONSTANTS**, which
    pulls their composition roots into its module graph. A `./paths` subpath
    export on each service would keep the constant without the graph.
