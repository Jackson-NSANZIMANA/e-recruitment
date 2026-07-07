# Identity Service — First Vertical Slice (2026-07-07)

The `identity-service` is the **NIDA-anchored system-of-record** for
`public_core.applicant_identities`. This first slice takes a raw National ID
all the way to a verified, PII-encrypted identity row and a correlated event —
exercising every foundation layer (types → security → database+RLS → events →
G2G) through one thin, runnable path. It is the template every other service
follows.

## Flow

```
raw NID ─(validate)─► hashNationalId(NID, NATIONAL_ID_HMAC_KEY) = internal applicant key
        │                                                          (stored, system-wide)
        ├─(dedup)───► repository.findIdByNationalIdHash → ALREADY_EXISTS (no G2G call)
        │
        └─(lookup)──► NidaGateway.lookupCitizen(NID)
                          │  hashes NID with the NIDA-shared secret, signs G2G request
                          ▼
                       NIDA registry (usrp-nida-mock in dev)
                          │
              FOUND + RWANDAN_CITIZEN ──► repository.createVerifiedIdentity
                          │                 [tx: SET ROLE usrp_system_service;
                          │                      set_config app.encryption_key (local);
                          │                      pgp_sym_encrypt PII columns;
                          │                      ON CONFLICT(national_id_hash) DO NOTHING]
                          │                     │
                          │                     ▼  emit NIDA_VERIFICATION_COMPLETED (vetting.nida)
              NOT_FOUND / NON_CITIZEN ──► emit AUDIT_ENTRY (audit.immutable), create no row
```

## Architecture — hexagonal (ports & adapters)

| Layer | Files | Depends on |
|-------|-------|------------|
| Domain | `domain/nida.types.ts`, `domain/identity.errors.ts` | nothing framework-specific |
| Ports | `ports/nida.gateway.ts`, `ports/identity.repository.ts` | domain only |
| Application | `application/verify-identity.service.ts` | ports + shared-security/events |
| Adapters | `adapters/nida.http-gateway.ts`, `adapters/identity.pg-repository.ts` | ports + infra |
| Composition | `config.ts`, `index.ts` | everything |

Business outcomes (`ALREADY_EXISTS`, `NOT_FOUND_IN_NIDA`, `NOT_A_CITIZEN`) are
**return values**, not exceptions. Only malformed input (`InvalidNationalIdError`)
and infrastructure faults (`NidaUnavailableError`, `IdentityPersistenceError`)
throw.

## The two-hash contract (important — do not conflate)

There are **two distinct HMAC-SHA256 hashes** of the same National ID, keyed
differently. The predecessor's material called both "nationalIdHash"; they are
not interchangeable:

| Hash | Key | Purpose | Where |
|------|-----|---------|-------|
| **NIDA lookup hash** | NIDA-shared secret (`NIDA_HMAC_SECRET`; dev `dev_nida_hmac_secret`) | Sent to NIDA; NIDA holds the reverse mapping | inside `NidaHttpGateway` only |
| **Internal `nationalIdHash`** | USRP-private `NATIONAL_ID_HMAC_KEY` | System-wide applicant key, stored in DB, used across all services | `hashNationalId(...)`, application layer |

The raw NID is treated as a secret: it never appears in an event, a log line,
or a return value — only its hashes and the resulting applicant UUID do.

## Foundation fix surfaced by this slice

`usrp_system_service` had only `SELECT, UPDATE` on `applicant_identities`, so
the system-of-record could not `INSERT`. Fixed in
`packages/shared-database/src/rls/0001_roles_grants_rls.sql`: the system service
now holds `SELECT, INSERT, UPDATE`; officers keep `SELECT, UPDATE` (they never
author identities). Hard `DELETE` is withheld from all app roles — erasure under
Law N° 058/2021 is the soft-delete (`deleted_at`) path.

## Divergences noted (not yet reconciled — tracked)

- **Env var names.** `.env.example` uses `NIDA_API_BASE_URL` / `DB_ENCRYPTION_KEY`;
  `@usrp/shared-config` (the contract) uses `NIDA_BASE_URL` / `PII_ENCRYPTION_KEY`
  / `NATIONAL_ID_HMAC_KEY`. This slice follows shared-config. `.env.example` needs
  reconciliation (part of the three-role-model / config cleanup).
- **HTTP/message transport is intentionally not wired yet.** The composition root
  takes an `EventBus` so the transport (NestJS vs minimal) is a deliberate next
  decision, not a default silently inherited.

## Verify it (live self-check)

Requires the Tier-1 stack up (`pnpm infra:up:tier1`) — Postgres + `usrp-nida-mock`.

```bash
DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
NIDA_BASE_URL='http://localhost:3100' \
NIDA_HMAC_SECRET='dev_nida_hmac_secret' \
NATIONAL_ID_HMAC_KEY='dev_national_id_hmac_key_min_32_chars!!' \
PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
pnpm --filter @usrp/identity-service selfcheck
```

`selfcheck/verify-slice.ts` asserts, against real infrastructure: identity
creation + event, PII encrypted-at-rest and decryptable, wrong-key rejection,
cross-agency RLS (an RDF officer cannot see a new identity that has no RDF
application), idempotency, the NOT_FOUND audit path, and that the raw NID never
leaks into events. It is repeatable (cleans its rows before and after) and exits
non-zero on any failure.

## Deferred to next slices

1. ~~HTTP/message ingress transport + framework decision (candidate ADR-005).~~
   **Done** — see `ADR-005` and `identity-service-http-slice.md`. The service now
   runs over `@usrp/shared-http`.
2. Biometric 1:1 match (populates `nidaMatchConfidence`; biometric-service).
3. `applicant_sessions` (web/USSD) + phone OTP verification.
4. `.env.example` ↔ shared-config reconciliation; the three-role-model cleanup.
