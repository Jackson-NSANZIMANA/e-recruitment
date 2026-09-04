# ADR-021 — The Edge Tier

**Status:** Accepted
**Date:** 2026-09-04
**Decision by:** Owner ruling, 2026-09-04 ("build the BFF tier properly")
**Supersedes:** the four-BFF topology asserted in `usrp-ui/docs/architecture/frontend-architecture.md` §3.1
**Related:** ADR-005 (exact path matching), ADR-012 (officer principals on verify), ADR-014 (cross-agency accept lock), ADR-016 (system tokens, non-revocable officer JWTs), ADR-018 (opaque revocable citizen sessions)

---

## 1. Context

The frontend monorepo has, since 2026-08-06, been written against a tier that does not exist.

`usrp-ui/docs/architecture/frontend-architecture.md` §3.1 asserted four Backend-For-Frontend services — `rdf-bff`, `rnp-bff`, `rcs-bff`, `superadmin-bff` — and stated that "the frontend never talks to individual microservices directly."

Neither this repository's `services/` (eleven services) nor its `packages/` (eight shared packages) contains any of them. They were never built. Consequently the shipped `@usrp/api-client` and `@usrp/auth` on the frontend's `main` point at `https://bff.rdf.usrp.gov.rw/api/v1` and at `/auth/login`, `/auth/me`, `/auth/logout` — four endpoints no service serves.

This is not a missing feature. **It is a missing architectural tier**, and it is the root cause of the frontend being non-functional: three of the operations a citizen needs most — `POST /v1/identities/verify`, `POST /v1/applications`, `POST /v1/documents/upload` — are all `reach: service-internal`. A browser cannot legitimately reach any of them. Without an edge, the applicant portal cannot verify a National ID, file an application, or upload a document. Not "badly" — at all.

### What the frontend already tells us

The decision below is **not** a fresh design. The frontend's unmerged `feat/agent2-auth-transport` branch already contains a complete, machine-checked specification of the tier it needs:

- `packages/api-client/src/paths.ts` — `EDGE_OPERATIONS`: 23 operations, each with an exact path, HTTP method, the upstream `operationId` it fronts, the session kind permitted, and whether a 503 may be retried.
- `packages/auth/src/edge-client.ts` — `EDGE_PATHS`: the seven auth/session paths, plus the CSRF cookie names and header.
- `packages/auth/src/session.ts` — the session view the edge must return, as a discriminated union.

`assertPathsMatchContract()` runs at module load and refuses to import if any referenced upstream operation has vanished or is `service-internal` without being explicitly declared brokered. The consumer contract is therefore already enforced. This ADR ratifies it and specifies the server side.

---

## 2. Decision

### 2.1 ONE edge, not four BFFs

A single service, `services/edge-gateway`, serving all browser traffic at `/edge/v1/**`.

The frontend's registry contains no agency segment in any path, and every officer operation derives agency from the session. Four per-agency BFFs are therefore rejected, on three grounds:

1. **Agency becomes server-authoritative by construction.** With agency read from the session rather than the request, there is no field for a client to tamper with. `AgencyGuard` stays what it always should have been — presentational — and the database's `FORCE`'d RLS remains the only real boundary. Four BFFs would have invited an agency path segment, which is a client-supplied authorization input.

2. **A citizen is cross-agency by nature.** ADR-014's accept lock spans all three agencies, and `listMyApplications` unions all three ops schemas. A per-agency BFF would force the citizen portal to ask "which agency portal?" — modelling the officer's world rather than the applicant's. `ApplicantSession` deliberately carries **no** agency field.

3. **One of everything that must not diverge.** One CSRF posture, one cookie configuration, one session store, one audit seam, one rate limiter. Four copies of a security control is four opportunities for three of them to drift.

**No superadmin edge.** The deprecated `shared-types` annotated `OfficerRole.SUPERADMIN` as "no RLS". RLS is `FORCE`'d with `NOLOGIN` group roles and there is no bypass principal, so that role is not merely absent from the edge — it is unrepresentable end to end. It is not carried forward. Administrative surfaces, if needed, get a separately-authenticated console and their own ADR.

### 2.2 The edge holds the credentials. The browser holds a handle.

There are two human credential kinds and they are **not** interchangeable:

| | Officer | Applicant |
|---|---|---|
| Credential | Ed25519 bearer JWT (iam-service) | opaque 32-byte DB session token (identity-service) |
| State | stateless, verified by public key | DB-backed, 30-min sliding TTL |
| Revocable | **no** — until expiry, by design (ADR-016) | yes, at the next request (ADR-018) |

**Neither ever reaches the browser.** The browser receives an opaque edge session handle in an `httpOnly`, `SameSite=Strict`, `Secure`, `__Host-`-prefixed cookie. The edge maps that handle to the real upstream credential server-side.

This is the entire security property, not an inconvenience to engineer around. ADR-018 chose a revocable citizen token specifically so a stolen session could be killed; revocability is worth nothing if the token lives anywhere script can read it. And because officer JWTs are non-revocable, the edge handle is the **only** revocation point that exists for an officer — killing the handle is how you end an officer session before its JWT expires.

Corollaries, all mechanically enforced on the frontend already:

- **No `Authorization` header, ever.** `transport.ts` has no code path that can add one.
- **`patch` and `del` do not exist.** No route in the platform accepts either verb. The helpers were removed because keeping them is what invited the fictional generic `PATCH /applications/{id}/status`.
- **`nationalIdHash` never crosses the edge from a browser.** A Rwandan National ID is 16 structured digits; an unsalted hash of it is a reversible identifier, brute-forceable offline in seconds. Identity resolution happens server-side against NIDA. The edge must reject any request body containing such a field rather than forwarding it.

### 2.3 CSRF: double-submit, and it must fail loudly

`SameSite=Strict` is necessary but not sufficient. The edge issues a second, **readable** cookie whose value must be echoed in the `x-csrf-token` header on every unsafe request.

| | |
|---|---|
| Cookie (production) | `__Host-usrp_csrf` |
| Cookie (development) | `usrp_csrf_dev` |
| Header | `x-csrf-token` |

Two names because `__Host-` cannot be used over plain `http` — browsers silently drop such a cookie — while production must use it. The frontend tries both.

The CSRF cookie is **not** a credential and is deliberately not `httpOnly`: on its own it authenticates nothing, and it is useless without the session cookie no script can read.

A missing or mismatched header is a **403**. The frontend sends the header when present and otherwise lets the write fail — correct by design: a forgotten CSRF token must break visibly in development rather than silently weaken CSRF in production.

### 2.4 Exact paths, no parameters

`shared-http` matches paths exactly and has no parameter syntax (ADR-005). Single-record reads therefore use a query string: `GET /edge/v1/applications/by-id?applicationId=`.

This is why the old frontend's `GET /applications/${id}` and `PATCH /applications/${id}/status` were unroutable — they type-checked perfectly and 404'd in production for every input. The edge inherits the exact-path rule; `paths.ts` enforces it at module load and `check-exact-paths.ts` enforces it at build.

### 2.5 Four transitions, not one

There is **no generic status transition** and the edge must not invent one. The real surface is four separately-guarded operations, each with its own body, its own authorization, and its own outcome union:

`recordMedicalReview` · `recordFinalDecision` · `acceptApplication` · `adjudicateApplication`

**None returns an application.** The frontend's old hook was typed to receive one and wrote the response into its detail cache, which would have poisoned the cache even if the route had existed. Callers re-read after a transition.

They are separate because they carry different authority. Collapsing them into one field write is a broken authorization model, not a URL style choice.

### 2.6 Retry is a property of the operation, not the call site

Every operation carries `retryOnG2G`. It is **false for every write that changes application state** — a retried transition is a double write against a citizen's legal record. `transport.ts` reads the flag from the registry, so a call site cannot opt a write into retrying.

G2G faults are `503` with a named authority (`NIDA_UNAVAILABLE`, `NESA_UNAVAILABLE`, `RIB_UNAVAILABLE`, `HEC_UNAVAILABLE`, ...). These are safe to distinguish, and should be: "the national ID service is down, try shortly" is actionable, "something went wrong" is not.

### 2.7 What the edge must refuse to leak

These are contract obligations, not implementation preferences. Each already exists as a proven property upstream and must survive the edge:

1. **Bare 404s.** A sibling agency's real application id and a nonexistent one return byte-identical responses, so an officer cannot walk ids to learn what another agency is processing. Proven in the backend's detail-reads selfcheck. The edge must not enrich a 404 with anything.

2. **One login failure.** Unknown handle, wrong password, and disabled account are indistinguishable. `AuthAttempt` has a single bare `rejected` case with no detail field, so the frontend physically cannot render a message that differentiates them.

3. **No document forensic verdict to the applicant.** `POST /v1/documents/upload` returns `{ status, documentId, documentType }` — no lane, no score, no flags. A score handed to the uploader is a forgery-tuning oracle: edit, re-upload, watch the number move, repeat until GREEN. Malware is the sole exception (`422 DOCUMENT_REJECTED_MALWARE`) because a binary antivirus verdict teaches a forger nothing, and silently accepting an infected file the citizen believes was received is unusable for a legal process.

4. **No NID validity oracle.** `202 Accepted` on OTP request means the request was accepted and **nothing more**. It must not indicate whether the National ID exists or whether an SMS was sent. The deprecated frontend doc specified a green checkmark on NID field blur; at national scale on an unauthenticated endpoint that is a bulk identity-enumeration channel. It is rejected. Note this is the same reasoning as (3), which the previous architect applied correctly to documents and inverted for NIDs four days later.

5. **`x-correlation-id` threaded, never invented twice.** The browser mints one per user action and the edge forwards it, so a click stitches to the backend events and Kafka trace it causes.

---

## 3. Consequences

**Good.** The frontend becomes functional at all. Agency is server-authoritative by construction. Officer sessions gain a revocation point they do not otherwise have. The three `service-internal` operations become reachable by a citizen through exactly one audited, rate-limited, CSRF-protected door.

**Costs, honestly.** The edge is now a single point of failure for all browser traffic and must be deployed accordingly. It is also a new trust boundary holding live credentials for every session, which makes it the highest-value target in the platform — it needs the same operational seriousness as the HSM path. And it is a second place where the route table lives, which is why `assertPathsMatchContract()` and gate B of the contract-drift checker are load-bearing rather than nice-to-have.

**Rejected alternative: re-point the frontend at services behind a plain gateway.** Faster to green, but it pushes session handling, token exchange and identity resolution into the browser. That re-creates the client-side identity problem by design and puts a non-revocable officer JWT somewhere script can read it. Not acceptable for a national deployment.

---

## 4. Verification

This ADR is not self-certifying. It is bound to executable checks:

| Property | Enforced by |
|---|---|
| No templated path | `assertPathsMatchContract()` at module load; `check-exact-paths.ts` at build |
| No `service-internal` route proxied unless declared brokered | `assertPathsMatchContract()`, with `BROKERED` as an auditable one-line allowlist (currently: `verifyIdentity`, per ADR-012 D1) |
| No `nationalIdHash` in shipped code | `@usrp/contracts` lint rule `no-national-id-hash` |
| Neither credential is a cookie | `@usrp/contracts` lint rule `no-cookie-credential` |
| System token never browser-reachable | contract route audit (ADR-016 rule) |
| Public unauthenticated surface | explicit 4-operation allowlist; a fifth costs a reviewer's signature |
| Edge route table matches backend reality | contract-drift gates A and B |

The openapi document at `services/edge-gateway/openapi/edge-v1.yaml` is the interface both repositories compile against.
