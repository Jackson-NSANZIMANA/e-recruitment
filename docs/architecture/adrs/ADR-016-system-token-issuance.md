# ADR-016 — System Token Issuance: Client-Credentials Against an IAM-Only Store

**Status:** Accepted (owner-signed 2026-07-26)
**Related:** ADR-002 (schema isolation), rls/0001 (roles/grants), rls/0010 (officer accounts), rls/0015 (service accounts), the iam issuer slice (officer login)

## Context

Every internal front door in the platform is already gated on a verified
Ed25519 bearer token: `withAuth(verify, { kind: 'system' | 'officer' }, …)`.
The **officer** half of that story was closed by the iam issuer slice —
`POST /v1/auth/officer/login` mints real 1-hour officer tokens from the
`public_core.officer_accounts` credential store.

The **system** half had no issuer at all. `kind:'system'` routes — submit
application, the three eligibility endpoints, document-forensics analyze,
identity verify — were reachable only with tokens minted *inside selfchecks*
holding the dev private key. A production worker (the tier1 pipeline, a
projector, a scheduled job) had **no way to obtain a token**, which meant the
autonomous pipeline could not actually run end-to-end outside a proof.

Constraints carried from the platform's standing invariants:

- **iam-service is the SOLE private-key holder.** Nothing else may mint.
- **A system principal is cross-agency by construction** —
  `dbRoleForPrincipal(system) → usrp_system_service`; its claims carry **no
  agency and no roles keys** (omitted entirely, never `undefined` —
  `exactOptionalPropertyTypes` discipline).
- **No credential material ever leaves the issuer** — not in responses, not
  in logs, not in audit events.

## Decision

### Client-credentials grant against a dedicated store

A machine client authenticates with `{ clientId, clientSecret }` at
`POST /v1/auth/service/token` and receives a short-lived `kind:'system'`
token — the exact mirror of officer login, deliberately reusing its proven
shape end to end:

| Layer | Officer (existing) | System (this slice) |
|---|---|---|
| Store | `public_core.officer_accounts` (rls/0010) | `public_core.service_accounts` (rls/0015) |
| Secret at rest | scrypt digest | scrypt digest (same `hashPassword`) |
| Use case | `OfficerLoginService` | `ServiceTokenService` |
| Route | `/v1/auth/officer/login` | `/v1/auth/service/token` |
| Rejection | one 401 `INVALID_CREDENTIALS` | one 401 `INVALID_CLIENT` |
| Claims | `kind:'officer'` + agency + roles | `kind:'system'`, **no** agency/roles |
| Token `sub` | officer UUID | `service_accounts.service_id` UUID |

**Why client-credentials and not the alternatives considered:**

- **Static long-lived tokens** (mint once, put in env): no expiry pressure,
  no revocation point, a leaked env var is a permanent skeleton key. Rejected.
- **mTLS service identity**: strongest binding, but demands a cert authority
  and rotation infrastructure the project does not have; it is a *hardening
  follow-on* (binding the token to a client cert), not a substitute for an
  issuance protocol. Deferred.
- **Client-credentials** is the OAuth2 pattern purpose-built for
  machine-to-machine auth, and it reuses the officer-login machinery this
  platform has already proven live: scrypt verification, no-enumeration
  rejection, success-only audit, Ed25519 minting.

### D3 — System-token TTL is 15 minutes (owner, 2026-07-26)

`SYSTEM_TOKEN_TTL_SECONDS = 15 * 60`. Machines re-fetch silently, so a short
TTL costs nothing operationally and bounds a stolen token's usefulness far
tighter than the human 1-hour officer TTL (which stays unchanged).

### The credential store is readable by iam-service ALONE (rls/0015)

`public_core.service_accounts` gets `SELECT, INSERT, UPDATE` for
`usrp_iam_service` only, with FORCE'd RLS and a single policy for that role.
**Deliberately no grant to `usrp_system_service`**: the workers who *use*
system tokens can never read the credentials that *mint* them — a
compromised worker cannot harvest minting material. Probed live: `SET ROLE
usrp_system_service; SELECT …` → `permission denied`.

### No enumeration, success-only audit

Unknown client, wrong secret, and **disabled** client all return one
byte-identical 401 `INVALID_CLIENT`. On success — and only on success — one
`AUDIT_ENTRY` is published: `action: 'SYSTEM_TOKEN_ISSUED'`,
`entityType/agency: 'SYSTEM'`, `performedBy: <service UUID>`, metadata
`{ method: 'client_credentials' }`. Never the clientId, never any secret or
digest. Failed attempts emit nothing (mirrors officer login; a failure-side
audit is a follow-on shared with login rate-limiting).

## Proof (gate #30 — `verify-service-token-slice.ts`)

Live, re-runnable, green ≥2×: seeds the account **as `usrp_iam_service`**
(proving the rls/0015 grant + WITH CHECK), mints over real TCP, then closes
the loop both ways — the minted token is **accepted (201)** by the real
application-service submit route and **rejected (403)** by an officer-only
route; wrong/unknown/disabled → byte-identical 401; tampered and expired
tokens → 401 at the consuming route; exactly one secret-free
`SYSTEM_TOKEN_ISSUED` audit; officer login regression-guarded.

## Consequences

- The autonomous pipeline can now authenticate itself in production shape:
  fetch a 15-minute token with its client credentials, call the system front
  doors, re-fetch on expiry. The dev seed (`seed-dev-officers.ts`) provisions
  one `dev.pipeline` client for the tier1 stack.
- The platform now has **two and only two** unauthenticated business routes —
  officer login and service token — both of which exist to mint the tokens
  everything else requires.
- Any new machine consumer is provisioned by inserting one row (as
  `usrp_iam_service`) — no code change, no new key material.

## Follow-ons (explicitly out of scope, flagged)

1. **Secret rotation** — dual-secret overlap window so clients rotate with
   zero downtime; today rotation = update row + redeploy client.
2. **Per-service scopes** — every system token currently opens *every*
   `kind:'system'` door; scoping (e.g. `submit-only`) needs a claims field +
   `withAuth` extension.
3. **mTLS / proof-of-possession binding** — bind tokens to a client cert or
   key so a stolen bearer token alone is useless.
4. **Provisioning & revocation workflow** — creating/disabling clients is a
   manual SQL operation today; `status='disabled'` is the kill switch (takes
   effect at next re-fetch, ≤15 min).
5. **Failure-side audit + rate limiting** — shared follow-on with officer
   login: today neither records failed attempts nor throttles them.
