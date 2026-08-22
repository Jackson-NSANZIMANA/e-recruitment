# The dev-boot seam — 37 proofs, and none of them ran `pnpm dev`

**2026-08-19.** `pnpm dev` failed for every service in the workspace. Nine
died on `DATABASE_URL environment variable is required`, thrown from
`shared-database/src/client.ts:17`; `background-vetting-service` and
`biometric-service` died on a clean `EnvValidationError`. The gate was
37/37 green throughout. Both facts were true at the same time, and the
reason they could be is the actual finding here.

## The seam

Every proof in the repo runs through `run-selfchecks.sh`, which exports its
own dev environment inline. **No proof has ever read `.env.example`.** And
`setup-dev.sh` does `cp .env.example .env`, so that unproven file is exactly
what every fresh clone starts from.

So the template drifted, silently, for roughly thirty slices:

| Drift | Detail |
|---|---|
| Four wrong G2G names | `NIDA_API_BASE_URL`, `NESA_API_BASE_URL`, `RIB_API_BASE_URL`, `HEC_API_BASE_URL`. The canon has no `_API_`. |
| Wrong Kafka port | `localhost:9092` — the in-network listener. Host processes need `:29092`. |
| Missing master keys | `PII_ENCRYPTION_KEY` absent; `NATIONAL_ID_HMAC_KEY` present only under the unread name `DB_ENCRYPTION_KEY`. |
| Dead placeholders | `AUTH_JWT_PUBLIC_KEY_B64=CHANGE_ME_BASE64_SPKI_PEM`, private key commented out. `createPublicKey` throws on both. |
| Missing outright | the QR trio, `IAM_BASE_URL`, `APPLICATION_SERVICE_BASE_URL`, `IDENTITY_CLIENT_ID/SECRET`, `DATABASE_MAX_CONNECTIONS`, `KAFKA_SSL`, `G2G_TIMEOUT_MS`. |
| `PORT_*` read by nothing | eleven scoped names in the file, zero references in code. |

The RIB naming was **already known**: `background-vetting-service/src/config.ts`
carries a comment saying `.env.example` uses the divergent spelling and that
reconciliation is "a tracked housekeeping item". A comment is not an
invariant — the same lesson `schema-evolution.md` records about the
`drizzle-kit generate` prohibition.

## Three defects, not one

**1. Nothing loaded `.env`.** Turborepo does not read `.env` files and
neither does `tsx`. Turbo 2.x *additionally* runs in **strict env mode by
default**, so a task's child process only receives variables enumerated in
that task's `env`. The `dev` task had no `env` block at all. **Both halves
are required**, which is why fixing either one alone left `pnpm dev` broken
and made this look intermittent. `scripts/dev.sh` is now the single loading
boundary (`set -a; source .env`, the idiom the gate already uses) and
`turbo.json` declares the crossing. Strict mode stays: in a system where a
missing `PII_ENCRYPTION_KEY` must fail loudly, `--env-mode=loose` is the
wrong trade.

Rejected: `--env-file=../../.env` in eleven service `package.json` files.
Eleven hard-coded copies of the repo layout, per-service drift, and a
downgrade from `tsx watch` restart semantics for no gain.

**2. The DB client read config at import.** `client.ts` read
`process.env['DATABASE_URL']`, threw, and opened a 20-connection pool — all
at module scope. Because `index.ts` re-exports the row *types* from there,
`import type { RdfApplication }` was enough to connect to Postgres. And
because the import graph beats `main()`, this bypassed `@usrp/shared-config`
entirely: nine services reported one variable in a bare stack trace, while
the two that reach `loadEnv` properly reported *every* missing variable at
once. **Two failure idioms in one repo, and the worse one won.** The client
is now lazy, so `loadDatabaseConfig()` runs first and the aggregated error
is the normal failure mode. `db` and `sql` stay live bindings via a proxy;
no call site changed.

**3. All eleven services resolved `:3000`.** `loadRuntimeConfig` read a bare
`PORT` defaulting to 3000, and `turbo run dev --parallel` hands every
service the same environment. First to bind wins; the other ten die on
`EADDRINUSE`. **Nobody had ever seen this** — the env failures killed the
processes before any of them reached `listen()`. It was the next error in
the queue. `loadRuntimeConfig` already receives the service name, so the
scoped key is now *derived*: `identity-service` → `PORT_IDENTITY_SERVICE`,
resolving `PORT_<SERVICE_NAME>` → `PORT` → 3000.

## Key separation (not a cleanup — a security boundary)

The QR slot-invitation keypair is **separate** from the bearer-token
keypair, and `generate-env.sh` asserts they differ before writing. The QR
*public* half is distributed to offline field devices at exam gates. Reusing
the token issuer's keypair would put the minting trust anchor on every
tablet, so one stolen device would forge bearer tokens as well as slot
invitations. Different trust domain, different custody, different rotation.
Dev defaults become production templates; they have to model the real shape.

## The contract

1. **Code is the name canon.** `packages/shared-config/src/config.ts` plus
   each service's `src/config.ts`. `.env.example` follows; never the reverse.
2. **The template must boot the platform.** `scripts/verify-dev-boot.sh`
   starts all eleven services from `.env.example` and asserts each answers
   `/ready` (or `/health` for the DB-free gates) on its own port, with no
   two claiming the same one.
3. **`generate:env` is the way in.** It renders `.env` and mints two
   distinct dev keypairs, so no two clones share signing material.

Proven both directions before commit: green on the reconciled template
(11 services, 11 distinct ports), red on an injected port collision, red on
a removed scoped variable, and red against the pre-fix repo state.
Registered as the final gate section — broadest and most infra-heavy, and
booting eleven services joins real consumer groups, which must not perturb
the behavioural proofs. **Gate 37 → 38.**

## Consequence

The rule this seam produces: **a surface no proof executes will drift.** It
held for the drizzle snapshot, it held for the "known single-broker flake"
that was really a consumer-group defect, and it held here. The three
artefacts a change can touch — code, template, gate — must move together,
and the gate is what makes that enforceable rather than remembered.

## Still open (deliberately not in this slice)

- **`process.env` reads outside the config layer.** Every `main.ts` checks
  `process.env['KAFKA_BROKERS']` directly to choose Kafka vs the in-memory
  bus. It works once the environment is loaded, but it is a second source of
  truth beside `loadKafkaConfig`. `configureDatabase()` is the seam for
  finishing this properly: hand the composition root's validated config down
  instead of re-reading the environment in leaf modules.
- **Two root scripts point at files that do not exist:** `security:scan`
  (`scripts/security-scan.sh`) and `certs:rotate`
  (`scripts/rotate-dev-certs.sh`). `generate:env` was the third until this
  slice; it is the reason the drift went unnoticed, so the other two are
  live risks of the same kind.
- **`lint` and `typecheck` must be run on this branch.** The lazy client
  uses proxies, and the repo runs `tsc --strict` with a custom eslint base.
