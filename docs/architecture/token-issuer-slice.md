# Slice — The Token Issuer: real officer login (`iam-service`)

**Status:** landed. Branch `feat/autonomous-eligibility-pipeline`. Step 1 of the owner-decided **visible-value vertical** (token issuer → containerize+deploy → officer console).

## Why this slice exists

`signAuthToken` (Ed25519 bearer tokens) and the officer endpoints that accept them shipped in earlier slices — but `signAuthToken` was **only ever called inside selfchecks**. There was no login endpoint and no officer-account store, so **nobody — officer or citizen — could log in outside a test.** That was the #1 go-live blocker: the whole authenticated surface (the Slice-4 officer lifecycle, the officer read) was unreachable by a real human. This slice mints the key.

**Outcome:** a real `POST /v1/auth/officer/login` that verifies an officer's handle + password and mints an Ed25519 bearer token the **existing** officer endpoints already accept. The proof closes the loop live: **iam-service mints → the real application-service officer endpoint accepts.**

## The new service — `services/iam-service`

A lean hexagonal service (composition mirrors `audit-service`; repo/HTTP/auth patterns mirror `application-service`). One public business route:

```
POST /v1/auth/officer/login  {loginHandle, password}  →  200 {token, expiresAt}
```

Flow:
1. **Read the account AS `usrp_iam_service`** — `SET LOCAL ROLE usrp_iam_service`, `SELECT … FROM public_core.officer_accounts WHERE login_handle = $1`. This role is the SOLE role granted on the credential store (see below).
2. **`verifyPassword`** (scrypt, constant-time) against the stored digest.
3. **Mint** via `signAuthToken(privateKeyPem, claims)` with claims `{v:1, iss, aud, sub: officer UUID, kind:'officer', agency, roles, issuedAt, expiresAt}`.
4. **Emit one PII-free `AUDIT_ENTRY`** (`OFFICER_LOGIN_SUCCEEDED`, `performedBy` = officer UUID) — on success only.

Files: `src/config.ts` (runtime + database + issuer private key), `src/ports/officer-account-repository.ts`, `src/adapters/officer-account.pg-repository.ts` (the `usrp_iam_service` read seam), `src/application/officer-login.service.ts` (verify → mint → audit; clock injectable), `src/adapters/http/officer-login.controller.ts` (the one public route), `src/index.ts` (composition root), `src/main.ts` (bootstrap). Dev seed: `scripts/seed-dev-officers.ts`.

## The asymmetric trust split (the point of it)

iam-service is the **SOLE holder of the issuer PRIVATE key** (`loadAuthIssuerConfig` → `AUTH_JWT_PRIVATE_KEY_B64`, PKCS#8 PEM, validated fail-loud at boot). Every **other** service holds only the PUBLIC key (`loadAuthVerifyConfig`) and can verify but never mint. A token minted here is offline-verifiable by any service with the public key — no DB round-trip, no shared secret. This is the whole reason the auth tokens are Ed25519-signed rather than opaque.

## Owner-decided security posture (2026-07-12)

| Decision | Choice | Rationale |
|---|---|---|
| **D1 — where credentials live** | `public_core.officer_accounts` | Reuses the `field_devices` cross-agency registry pattern (same schema, agency-column FORCE'd RLS). |
| **D3 — who reads the credential store** | **new `usrp_iam_service` role, ALONE** | Password hashes are the crown jewels. Unlike every other table (readable by `usrp_system_service`, which many services assume), the credential store has **no officer and no system_service policy** — only `usrp_iam_service`. A compromise of any other service cannot read hashes. **Verified live:** `usrp_iam_service` reads/writes; `usrp_system_service` is denied SELECT at the engine. |
| **Token TTL** | **1 hour** | Bounds a stolen-token window before a refresh mechanism exists. |
| **D2/D4 — factor + scope** | handle + password, **node:crypto scrypt**; **officer login only** | scrypt (not argon2/bcrypt) holds the zero-runtime-dependency invariant for shared packages — a native KDF dep is rejected. |

## No user-enumeration

Unknown handle, wrong password, and disabled account all return **one identical `401 INVALID_CREDENTIALS`** (byte-identical body — asserted in the proof). The password and the stored hash never leave the use case, are never logged, and never appear in a response or the audit event.

## Foundations added

- **`shared-security`**: zero-dep `hashPassword` / `verifyPassword` — `scrypt$N$r$p$saltB64$hashB64`, random per-hash salt, `timingSafeEqual`, never-throws (malformed digest → false, fail closed). Deterministic proof `verify-password-kdf.ts`.
- **`shared-config`**: `loadAuthIssuerConfig` — the private-key mirror of `loadAuthVerifyConfig`.
- **`shared-database`**: migration `rls/0010_officer_accounts.sql` (table + `usrp_iam_service` grant + FORCE'd RLS policy `pc_oa_iam`), the `usrp_iam_service` role added to `rls/0001`, and the `officerAccounts` drizzle mirror. `officer_id` is a **UUID** so the minted token's `sub` lands cleanly in the UUID `medical_reviewed_by_id` / `final_decision_by_id` officer-stamp columns (Slice 4).
- **`bootstrap-db.sh`**: applies 0010; then a **best-effort dev-officer seed** (`rdf.officer` / `rnp.officer` / `rcs.officer`, dev password `DevOfficer#2026`) — the first seeding pathway in the repo, so the coming officer console has real credentials. Best-effort: a seed failure never blocks the structural bootstrap.

## Proof — `services/iam-service/selfcheck/verify-iam-issuer-slice.ts` (live, THE LOOP-CLOSER)

One in-test keypair; iam-service holds the private half, the real application-service officer route holds the public half — the production split, both halves in one process. Asserts:
- seed an officer AS `usrp_iam_service` (proves the grant + policy);
- `POST /login` (good creds) → 200 + token; response leaks no password/hash;
- minted claims correct (`sub` = UUID, `kind` = officer, agency, ~1h expiry);
- **loop-closer:** the minted token on `GET /v1/applications` (real app-service route) → **200**, scoped to the token's agency, no PII leak;
- wrong password / unknown handle / disabled → **identical 401** (no enumeration);
- expired minted token and tampered token → 401 at the endpoint;
- the success `AUDIT_ENTRY` is PII-free (no password, no hash, no handle).

Registered in `run-selfchecks.sh` alongside the deterministic scrypt proof (gate 23 → 25).

## Deferred (flagged, not built)

System-token (client-credentials) issuance for the service-internal front doors (currently selfcheck-only); MFA / account lockout / login rate-limiting; real IdP/SSO + provisioning workflow; **HSM/KMS for the issuer private key + key rotation** (same residual class as the audit-owner key — the `keyId` mechanism is not yet used here). These are follow-ons, not blockers for a first officer login.

## What this unblocks

The next two steps of the vertical: (2) containerize + deploy one service (a Dockerfile for iam-service + application-service — the first real deployable unit), then (3) one real officer-console screen (login → list applications → act) — the first thing an agency officer can actually drive over the pipeline we already built.
