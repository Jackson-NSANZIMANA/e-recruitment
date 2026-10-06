# E2E proof runbook — proving the USRP backend by *running* it

> **Motto: "prove it, don't assert it."** This runbook exists to turn that motto into
> something you can execute on your own laptop: bring up the real infrastructure,
> bootstrap a real database, and run the repository's own quality gate — the same one
> CI runs — end to end. Nothing here asks you to trust a document; every step prints
> its own evidence.

**Who this is for:** a developer on an Ubuntu/Debian laptop (HP EliteBook 840 G3 class,
8–16 GB RAM) with Docker installed.

**What it proves when green:** cross-agency RLS isolation, the full citizen/officer HTTP
surface, Kafka round-trips and dead-letter containment, the transactional outbox, MinIO
document sealing + ClamAV scanning, biometric/field-sync/audit sinks, the whole
submission→vetting→DOCUMENT_REVIEW_GREEN spine, and the developer entrypoint itself
(all 12 services booting from the committed `.env.example`).

**What it does NOT prove:** production readiness. It is a dev-tier proof (dev secrets,
mock G2G registries, single-node broker). It proves *the code does what it claims*.

---

## 0. Quickstart (the whole thing, five commands)

```bash
git switch main && git pull                # 1. the commit under test
corepack enable && pnpm install --frozen-lockfile   # 2. Node 24 + pnpm 9.15
pnpm build                                 # 3. REQUIRED: proofs import @usrp/* from dist/
pnpm infra:up                              # 4. tier1 THEN tier2 (order matters: tier2's
                                           #    network is external to tier1's project)
[ -f .env ] || pnpm generate:env           # 5a. .env — skip if you already have one
pnpm bootstrap:db                          # 5b. schema + RLS + dev officers
pnpm verify                                # 6. THE GATE — 53 proofs
```

> **Step 3 is not optional.** Each `@usrp/*` package resolves **types** to `src/` and
> **runtime** to `dist/`. `dist/` is gitignored, so it is developer-local state: if you
> last built on another branch, `pnpm typecheck` stays green while every proof that
> imports a freshly-added symbol dies with
> `SyntaxError: … does not provide an export named '<symbol>'`. That is a stale artefact,
> not a code defect (see D4). This branch makes `pnpm verify` run `pnpm build` first —
> exactly like CI — but on an unfixed commit you must build yourself.

> **`pnpm infra:up` did not work before this fix.** It pointed at
> `docker-compose.infra.yml`, a file that has never existed (broken since the baseline
> commit; CI never noticed because CI calls the tier files directly). If you are on a
> commit *without* the fix, use the raw commands in §5 — they are what CI runs.

> **`.env` already exists is not an error.** `pnpm generate:env` refuses to overwrite it
> (exit 1 by design). Skip it, or force a fresh rotation with
> `bash scripts/generate-env.sh --force`. The gate does **not** read `.env` — it exports
> its own dev environment — so an existing `.env` cannot invalidate a proof run. Only
> `pnpm dev` (manual exploration in §9) reads it.

### Known-state notes for the current `main`

Checked on the unified `main` (all branches merged, 2026-10-06):

* **The gate holds 53 proofs. 10 need no infrastructure at all** and pass on a
  bare checkout with no Docker — they are listed in Appendix A. If those 10 are
  green and the other 43 are red, you are looking at missing/unhealthy infra,
  not at broken code. That exact 10/43 split is the measured signature of
  "Docker is not running".
* **`pnpm lint` fails with ~126 errors, and that is expected.** The lint
  toolchain was never installable before (eslint undeclared, config unreachable,
  `strictTypeChecked` set without `projectService`). It now runs for the first
  time and is reporting real, pre-existing debt. **CI does not run lint**, so
  this gates nothing — do not treat it as a regression and do not let it block
  the infra run.
* **`pnpm verify` builds first.** You do not need a separate `pnpm build`, but
  running one costs nothing and makes a stale-`dist` failure impossible.
* **`kafkajs@2.2.4` is carried as a pnpm patch (`patches/kafkajs@2.2.4.patch`).**
  A 53-proof run on Node 24 printed
  `TimeoutNegativeWarning: -1791317736822 is a negative number. Timeout duration
  was set to 1.` eight times — once per Kafka-touching proof process. That is
  upstream `RequestQueue.scheduleCheckPendingRequests()` computing
  `throttledUntil - Date.now()` while `throttledUntil` still sits at its initial
  `-1`; the magnitude is exactly `Date.now()` at that millisecond, and the
  positive clamp on the next line only runs when `pending.length > 0`. Node
  clamps the negative delay to 1 ms, the callback calls `checkPendingRequests()`
  unconditionally, which re-arms the same timer — a permanent **~900 no-op
  wakeups/sec on every broker connection that has ever completed a request**
  (13 consumers in this stack), pinning the event loop awake and inflating
  container CPU. The warning is the harmless part: Node ≥ 23 merely made a
  long-standing loop visible; on Node 22 it burns silently. kafkajs 2.2.4 is the
  latest release (2023-02-27; upstream is dormant), so the fix is vendored:
  return early when nothing is pending and no client-side throttle is active.
  Safe by construction — `push()` re-arms the timer whenever a request is really
  enqueued. Proven by driving the real `RequestQueue` class with no broker:
  idle wakeups **870 → 0**, and a saturated queue still drains
  (`sent: 3, resolved: 3, pending: 0, inflight: 0`, pending work still
  scheduled at the 10 ms clamp). CI then closed the remaining gap: the Proofs
  job on the patch commit brings up real tier1+tier2 Docker infra and runs the
  full 53-proof `pnpm verify` on **Node 24** — the version that printed the
  warnings — and passed with every Kafka proof green. The warning cannot recur
  because the patched code path never requests a negative delay. If a future
  kafkajs release embeds the fix, drop the patch file and the
  `pnpm.patchedDependencies` entry in `package.json` together.
* Evidence bundles land in `.prove-e2e/` and are gitignored. Attach the folder;
  do not commit it.

Or let the runner do all of it and write you an evidence bundle:

```bash
bash scripts/prove-e2e.sh            # full: infra + bootstrap + static gates + gate
bash scripts/prove-e2e.sh --quick    # tier1 only: DB-bootstrap + static gates + DB proofs
```

Budget: **first run 30–60 min** (ClamAV downloads its virus DB on first boot, and the
last proof boots all 12 services). Re-runs are much faster.

---

## 1. Machine prerequisites

| Requirement | Check | Notes |
|---|---|---|
| Docker Engine + Compose v2 | `docker compose version` | v2 syntax (`docker compose`, not `docker-compose`) |
| Node.js **>=24 <=25** | `node -v` | engines are enforced; nvm: `nvm use` reads `.nvmrc` |
| pnpm **9.15** | `pnpm -v` | `corepack enable` reads `packageManager` from package.json |
| RAM | `free -h` | ≥16 GB comfortable; 8 GB → see §11 "lean path" |
| Disk | `df -h .` | ≥20 GB free (ClamAV DB, Kafka logs, images) |
| Free ports | `ss -ltn` | 5432, 9000, 9001, 3100–3103, 8080, 8081, 9092, 29092, 3310 |

Any local Postgres/Kafka already listening on those ports will fail the compose bring-up.

## 2. Get the exact commit under test

```bash
git fetch --all --prune
git switch main && git pull
git rev-parse HEAD | tee .prove-e2e-commit.txt     # record it; the evidence bundle needs it
```

Record the hash. A green gate on an unknown commit proves nothing; a green gate on a
recorded hash is reproducible evidence.

> If you want to prove a *different* ref (a PR branch, a colleague's fork), check it out
> first and record its hash the same way. The gate does not care which ref it runs on.

## 3. Install (workspace deps)

```bash
corepack enable
pnpm install --frozen-lockfile
```

Expected: `Done in Ns`. If you see `ERR_PNPM_OUTDATED_LOCKFILE`, *stop* — a modified
lockfile means the tree is not the commit you think it is.

## 4. Static gates (fast, no infra)

```bash
pnpm turbo run build        # expect: Tasks: 20 successful, 20 total
pnpm turbo run typecheck    # expect: Tasks: 34 successful, 34 total (0 errors)
pnpm turbo run test         # expect: Tasks: 19 successful, 19 total
node scripts/check-workspace-build.mjs   # expect: "✓ workspace build present — 19 package(s) …"
```

That last line is the guard against stale build output: it imports every workspace
package's `dist/` and asserts that every value name its `src/index.ts` declares is
actually exported. It is **semantic, not timestamp-based** — a turbo cache hit
legitimately leaves `dist/` untouched (verified: `pnpm build` can report `FULL TURBO` and
not rewrite a single file), so mtime comparisons report false staleness. `pnpm verify` and
`bash scripts/run-selfchecks.sh` now both run this check.

Reality check on that last number, so you are not misled: only **5** of those 19 tasks
actually run tests (`shared-security`, `eligibility-service`, `application-service`,
`field-sync-service`, `edge-gateway` — 17 unit tests total). The other 14 are `build`
dependencies, and 14 of 20 packages have no `test` script at all. The *behavioural*
proofs are the selfchecks in §7, not these.

## 5. Infrastructure up

```bash
# Fixed one-command path (after the infra:up repair):
pnpm infra:up          # = tier1 (--build --wait) then tier2
pnpm infra:ps          # status of both projects

# Or the raw commands — what CI runs, and the fallback on any commit where
# `infra:up` still points at the never-existed docker-compose.infra.yml:
docker compose -f infrastructure/docker/docker-compose.tier1.yml up -d --build --wait
docker compose -f infrastructure/docker/docker-compose.tier2.yml up -d
docker wait usrp-kafka-init     # MUST print 0 — it creates the topics
docker logs usrp-kafka-init | tail -20
```

Order is load-bearing: tier2's network is declared `external: true, name: usrp-tier1_usrp-internal`,
so **tier1 must be up first** and **tier1 must be down last** (`pnpm infra:down` handles that order).

Wait until every container is `healthy` (or `running` for one-shot `kafka-init`, which
must have **exited 0** — it creates the topics, including `events.dead-letter`).

| Container | Purpose | Port(s) |
|---|---|---|
| `usrp-postgres` | the database (`usrp_admin` / `usrp_dev_password` / `usrp_db`) | 5432 |
| `usrp-minio` | encrypted document store + forensics quarantine | 9000 / 9001 |
| `usrp-nida-mock` / `usrp-nesa-mock` / `usrp-rib-mock` / `usrp-hec-mock` | G2G registries | 3100 / 3101 / 3102 / 3103 |
| `usrp-kafka` | event backbone, host listener `localhost:29092` | 9092 / 29092 |
| `usrp-clamav` | AV scanner (first boot downloads the virus DB — be patient) | 3310 |
| `usrp-kafka-ui` / `usrp-schema-registry` | inspection | 8080 / 8081 |

Sanity probe (no jq required):

```bash
docker exec -i usrp-postgres pg_isready -U usrp_admin -d usrp_db
curl -s http://localhost:3100/health && echo && curl -s http://localhost:3101/health
```

## 6. Environment file

```bash
pnpm generate:env            # mints FRESH dev Ed25519 keypairs, renders .env
```

`pnpm dev` requires `.env` (it is gitignored). `generate:env` mints **two separate**
keypairs — `AUTH_JWT_*` (bearer tokens) and `QR_*` (offline slot invitations) — and
asserts they differ. Use `--keep-keys` only if another tool of yours needs the template's
published dev keys.

## 7. Database bootstrap (schema + isolation + officers)

```bash
pnpm bootstrap:db
```

Canonical order, in one script: drizzle migrations `0000`+`0001` → `rls/0001`…`rls/0025`
(roles, FORCE'd RLS, audit immutability, processing-code sequences, campaign/venue
grants, outbox, slot ledger, submission ledger, rate-limit buckets, `pgcrypto`) → dev
officer seed.

Expected final line:
`✓ database bootstrapped — schema + isolation + audit immutability + … + required extensions in place`

Verify by hand:

```bash
docker exec -i usrp-postgres psql -U usrp_admin -d usrp_db -c '\dt public_core.*' | head
docker exec -i usrp-postgres psql -U usrp_admin -d usrp_db -c '\du' | grep usrp_
```

You should see the group roles `usrp_rdf_officer`, `usrp_rnp_officer`, `usrp_rcs_officer`,
`usrp_system_service`, `usrp_iam_service`, plus the login role `usrp_app`.

Common cold-bootstrap failure — **reset and retry** (the drizzle baseline owns schema
creation; a half-initialised volume makes it collide):

```bash
pnpm infra:reset && pnpm infra:up && pnpm infra:up:tier2 && pnpm bootstrap:db
```

## 8. THE GATE — `pnpm verify`

```bash
pnpm verify 2>&1 | tee .prove-e2e-gate.log
```

This runs `scripts/run-selfchecks.sh`: the RLS cross-agency isolation proof, then ~50
proofs in dependency order (each is a real program: it boots services in-process or on
sockets, hits the real Postgres/Kafka/MinIO/ClamAV/mocks, asserts, and exits non-zero on
failure), ending with `verify-dev-boot.sh`, which boots **all 12 services from
`.env.example`** through `scripts/dev.sh → turbo → tsx` and probes every `/health` +
`/ready`.

Expected tail:

```
Proofs: NN passed, 0 failed
ALL PROOFS GREEN — every invariant holds ✓
```

Run one proof at a time when something is red (`bash -c 'source <(grep "^export " scripts/run-selfchecks.sh); npx tsx <proof>'`
gives it the gate's environment), e.g.:

```bash
bash -c 'source <(grep "^export " scripts/run-selfchecks.sh); \
  npx tsx services/application-service/selfcheck/verify-submission-integrity.ts'
```

## 9. The spine, hands-on (optional but convincing)

The gate is the proof. If you want to *touch* it, the officer path is fully drivable over
HTTP with the seeded dev credentials (`rdf.officer` / `rnp.officer` / `rcs.officer`,
password `DevOfficer#2026`), with all 12 services running (`pnpm dev`):

```bash
# 1. officer login → bearer token
curl -s -X POST http://localhost:4011/v1/auth/officer/login \
  -H 'content-type: application/json' \
  -d '{"loginHandle":"rdf.officer","password":"DevOfficer#2026"}' | head -c 400

# 2. broker a read through the edge (replace <TOKEN>; CSRF applies to browser sessions,
#    the officer JWT path is what the console uses)
curl -s http://localhost:4021/edge/v1/applications -H "authorization: Bearer <TOKEN>"
```

Citizen path, over the wire: `POST /edge/v1/auth/verify-identity` (drives the NIDA mock)
and `POST /edge/v1/auth/request-otp` both work. **You cannot read the OTP** — by design it
is random, stored scrypt-hashed, and the dev SMS channel logs only a masked destination
and a body length:

```json
{"msg":"sms_would_send","channel":"LOG","destinationMasked":"***78","bodyLength":64}
```

That is a *feature*, not a gap in the proof: the in-process proofs hold the dev channel's
`sent[]` array and read the real code (`verify-applicant-auth-slice.ts` drives
request-otp → verify-otp → session; `verify-submission-integrity.ts` drives the
Idempotency-Key front door; `verify-pipeline-e2e.ts` drives submission →
all three gates → `DOCUMENT_REVIEW_GREEN`). Browser-level OTP entry is proven by those
three, not by curl.

## 10. Teardown

```bash
pnpm infra:down                                    # stop tier1
docker compose -f infrastructure/docker/docker-compose.tier2.yml down
pnpm infra:reset                                   # DESTRUCTIVE: drops the DB volume
```

## 11. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `compose file …docker-compose.infra.yml is invalid: … no such file or directory` | The `infra:up`/`infra:down`/`infra:reset`/`infra:logs` bug (never-existed filename). Fixed in this branch; on an unfixed commit use `pnpm infra:up:tier1 && pnpm infra:up:tier2`, or the raw commands in §5 |
| `✗ .env already exists — pass --force to overwrite` | Not a failure: `generate:env` protects your keypairs. Skip it, or `bash scripts/generate-env.sh --force` to rotate the dev keys |
| `SyntaxError: The requested module '@usrp/<pkg>' does not provide an export named '<x>'` in a proof | Stale build output (D4). Fix: `pnpm build` (use `pnpm turbo run build --force` if a cache hit does not rewrite it), then re-run. Diagnose before rebuilding: `node scripts/check-workspace-build.mjs` names the package and every missing export |
| `network usrp-tier1_usrp-internal declared as external, but could not be found` | You started tier2 before tier1. Run `pnpm infra:up:tier1` first (or `pnpm infra:up`) |
| `docker: command not found` / `Cannot connect to the Docker daemon` | Docker missing or daemon not running; the runner refuses to start without it |
| Port already in use (5432/9092/3000s) | Another Postgres/Kafka/your old `pnpm dev` is running: `ss -ltnp \| grep 5432`, stop it |
| `schema … already exists` during bootstrap | Half-initialised volume: `pnpm infra:reset && pnpm infra:up && pnpm bootstrap:db` |
| ClamAV container `starting` for minutes | Normal on first boot (virus-DB download). Watch: `docker logs -f usrp-clamav` |
| Kafka proofs fail but Postgres proofs pass | You started only tier1, or `kafka-init` did not exit 0 (`docker logs usrp-kafka-init`) |
| `EADDRINUSE` from the last proof | `verify-dev-boot.sh` boots 12 services on 4001–4011/4021; stop any `pnpm dev` first |
| Node engine warning `wanted: >=24 <=25` | Switch Node (`nvm use`) — proofs still ran on 22.x in my sandbox, but use 24 |
| 8 GB RAM, gate times out | **Lean path:** tier1 only; run the static gates + `pnpm verify:dev-boot` + the DB-only proofs (each with the env source line above). Appendix A lists which proofs need Kafka/MinIO/ClamAV — skip those four and you still cover the majority |
| `pnpm verify` red, which proof? | The runner prints `Failed proofs:` at the end; every proof's own output explains the invariant it enforces |

## 12. Evidence bundle (what makes a run *proof*)

Keep these together — this is the package that turns "it worked on my machine" into an
auditable claim:

```bash
mkdir -p .prove-e2e-bundle
git rev-parse HEAD > .prove-e2e-bundle/commit.txt
cp .prove-e2e-gate.log .prove-e2e-bundle/
docker compose -f infrastructure/docker/docker-compose.tier1.yml ps > .prove-e2e-bundle/tier1-ps.txt
docker compose -f infrastructure/docker/docker-compose.tier2.yml ps > .prove-e2e-bundle/tier2-ps.txt
ls .boot-logs > .prove-e2e-bundle/devboot-logs.txt
docker exec -i usrp-postgres psql -U usrp_admin -d usrp_db -c \
  "SELECT count(*) AS applications FROM rdf_ops.applications" > .prove-e2e-bundle/rows.txt
```

`bash scripts/prove-e2e.sh` does all of this for you into `.prove-e2e/run-<timestamp>/`
(including `RESULT.md` with per-phase PASS/FAIL and an environment fingerprint).

---

## Appendix A — which proofs need which infrastructure

Derived from the proofs' own imports; useful when a resource-constrained machine must
triage.

| Needs | Proofs |
|---|---|
| **Postgres only** (majority, ~30) | identity (auth/self-service/erasure/retention/http/slice), iam (issuer/service-token), eligibility (age/education/degree), application (auth/detail/history/officer-lifecycle/outbox/submission-integrity/submit-http/walk-in/auto-withdrawal), notification (contact/notices/invitation), scheduling (slot-integrity), field-sync, biometric, edge (session refresh/rate-limit store), audit… |
| **+ Kafka** (~8) | `verify-audit-slice`, `verify-event-driven`, `verify-vetting-slice`, `verify-slot-assignment`, `verify-pipeline-e2e`, `verify-vetting-projection`, `verify-dead-letter`, `verify-kafka-roundtrip` |
| **+ MinIO** (3) | `verify-document-upload-slice`, `verify-forensics-slice`, `verify-amber-adjudication-slice` |
| **+ ClamAV** (1) | `verify-forensics-slice` (also needs MinIO) |
| **No infra at all** (10) | `verify-production-guard`, `verify-deployment-hygiene`, `verify-edge-contract`, `verify-citizen-submit-readiness`, `verify-edge-hygiene`, `verify-slot-invitation`, `verify-password-kdf`, `verify-auth-token`, `verify-applicant-submit-gateway`, `verify-lifecycle` |

## Appendix B — signals already verified without Docker

From a sandbox run of this repo's commit `5db81ca` (same tree as the gate, minus live
infra). These are cheap sanity signals to compare against before the heavy run:

| Command | Result |
|---|---|
| `npx tsx services/edge-gateway/selfcheck/verify-edge-hygiene.ts` | `95 checks` GREEN |
| `npx tsx services/edge-gateway/selfcheck/verify-edge-contract.ts` | `387 checks`, no drift |
| `npx tsx services/edge-gateway/selfcheck/verify-citizen-submit-readiness.ts` | `READY` (structural) |
| `npx tsx services/identity-service/selfcheck/verify-applicant-submit-gateway.ts` | `56 checks` GREEN |
| `pnpm turbo run build / typecheck / test` | 20/20, 34/34, 19/19 |
| Unit suites (5 files) | 17 tests, 0 failures |

## Appendix C — corroboration: a real run without Docker (this sandbox)

Before you spend an hour on the full run, here is evidence that the DB-backed half of the
gate is genuinely green — produced by *executing* it against a real PostgreSQL, not by
reading code. Sandbox recipe: PostgreSQL 18.6 (PyPI `embedded-postgres` wheel) +
`pgcrypto` compiled from the official `REL_18_6` source against it + the repo's own
`scripts/bootstrap-db.sh` + the four G2G mocks run natively (`node server.js`). No Docker,
no Kafka, no MinIO, no ClamAV.

**Bootstrap (the repo's own script, unmodified):**

```
✓ database bootstrapped — schema + isolation + audit immutability + … + required extensions in place
✓ dev officer accounts seeded (rdf.officer / rnp.officer / rcs.officer)
```

**Zero-infra proofs:** edge hygiene 95 ✓ · edge contract 387 ✓ · citizen-submit readiness READY ✓ ·
applicant-submit-gateway 56 ✓ · production boot guard ✓ · build 20/20 · typecheck 34/34 · test 19/19.

**DB-backed proofs executed against the live database — 27 of 28 GREEN:**

| Proof | Result |
|---|---|
| `verify-schema-drift` | ✓ drizzle snapshot matches the schema |
| `verify-iam-issuer-slice` | ✓ *loop-closer*: minted token accepted by a real application-service route |
| `verify-service-token-slice` | ✓ client-credentials mint → system route accepts |
| `verify-applicant-auth-slice` | ✓ citizen → NIDA mock → `202 CHALLENGED` → OTP + session audits |
| `verify-applicant-self-service-slice` | ✓ withdraw own → erasure demand → DPO decision |
| `verify-submission-integrity` | ✓ ADR-027 ledger: replay, `ALREADY_APPLIED` wrote nothing |
| `verify-slot-integrity` | ✓ one invitation per application, no venue overbooked |
| `verify-applicant-*`, `verify-slice`, `verify-http-slice`, `verify-erasure-slice`, `verify-retention-sweep-slice` | ✓ identity surface incl. right-to-erasure and retention sweep |
| `verify-application-detail-reads`, `verify-history-immutability`, `verify-auto-withdrawal-slice`, `verify-officer-lifecycle-slice` | ✓ application-service surface |
| `verify-walk-in-slice` | ✓ register → vet → physical → merged funnel |
| `verify-field-sync-slice` | ✓ offline capture + CRDT merge + conflict adjudication |
| `verify-notification-slice`, `verify-contact-delivery-slice`, `verify-notices-slice` | ✓ invitations, contact capture, withdrawal notice |
| `verify-biometric-slice` | ✓ check-in gate + persistence |
| `verify-age-eligibility`, `verify-education-eligibility`, `verify-degree-eligibility` | ✓ age band, NESA, HEC gates |
| `verify-edge-security` | ✓ 123 checks — no credential crosses the browser boundary |
| `verify-rate-limit-store` | ✓ 23 checks — two instances, one shared Postgres window |
| `verify-audit-slice` | ✗ **needs Kafka** (`ECONNREFUSED localhost:29092`) — the only red, and it is an infra gap, not a code failure |

## Appendix D — defects the first local run surfaced (vindication of the method)

The very first attempt to follow this runbook on a developer laptop failed twice before a
single proof ran. Both were **real defects in the repository**, not environment problems —
which is the point of running instead of reading:

| # | Symptom | Root cause | Status |
|---|---|---|---|
| D1 | `compose file "…/docker-compose.infra.yml" is invalid: … no such file or directory` from `pnpm infra:up` (also `infra:down`, `infra:logs`, `infra:reset`) | The scripts referenced `docker-compose.infra.yml`, **a file that has never existed in any commit** (name introduced in the baseline commit `7b7745d`). CI never noticed because `.github/workflows/ci-backend.yml` calls the tier files directly. The documented developer path was broken while the CI path worked — invisible by construction | **Fixed** — `infra:up` = tier1 (with `--build --wait`, CI parity) → tier2; `infra:down`/`infra:reset` are ordered tier2 → tier1; `infra:ps` and `infra:logs:tier2` added |
| D2 | `pnpm mocks:up` → `docker-compose.mocks.yml: no such file or directory` | Same class: a second compose file name that never existed. The mocks are services *inside* tier1 | **Fixed** — `mocks:up` now starts `nida-mock nesa-mock rib-mock hec-mock` from tier1 |
| D3 | `✗ .env already exists — pass --force to overwrite` from `pnpm generate:env` | **Not a defect** — the script protects your keypairs. The failure is exit code 1 from a guard doing its job | Documented in §0/§6: skip it when `.env` exists (the gate ignores `.env` entirely) |
| D4 | Proofs die at import: `SyntaxError: The requested module '@usrp/shared-database' does not provide an export named 'stageOutboxEvents'` (slot assignment, slot integrity), `…'PgOutboxDispatcher'` (amber routing, walk-in, pipeline-e2e) | **Stale `dist/`**, not code, not infra. `@usrp/*` `exports` maps resolve **types → `src/`** and **runtime → `dist/`**, so `pnpm typecheck` cannot see it; `dist/` is gitignored, so a build from *another branch/commit* survives a checkout. The named symbols (`stageOutboxEvents`, `PgOutboxDispatcher`, `PgOutboxRelay`, `describeOutboxError`) are exactly the Oct-1 outbox lift (`c94286c`), so any dist older than that fails precisely here. **Reproduced deterministically** by deleting the built re-export line: byte-for-byte the same error; restored by `pnpm build` | **Prevented** — `pnpm verify` and `pnpm verify:dev-boot` now run `pnpm build` first (CI already did); `scripts/check-workspace-build.mjs` fails the gate with the missing names + the fix command; `prove-e2e.sh` runs it right after its build phase |

`bash scripts/prove-e2e.sh` now opens with a **script-reference check**: it parses every
`package.json` script, extracts referenced paths, and fails the run if any of them does not
exist. On this branch that check passes; on `main` before the fix it reports D1 and D2 in
one line, which is exactly how these should be found.

| D5 | Same class as D4, second occurrence, larger blast radius: **14 of 52 proofs red** — 11 application-service proofs (`front-door submit`, `submission integrity`, `officer auth + RLS`, `single-record reads`, `officer lifecycle`, `auto-withdrawal`, `vetting projection`, `transactional outbox`, `amber adjudication`, `walk-in lane`, `pipeline-e2e`), both scheduling proofs, and the 12-service dev boot, where `identity-service`, `biometric-service`, `notification-service`, `application-service` and `scheduling-service` each died at import | The build lagged the source by more than one wave: `@usrp/shared-config` had no `assertDevAdapterAllowed` (added **2026-10-01**, commit `4a93907`) and `@usrp/shared-database` had no `stageOutboxEvents`/`PgOutboxDispatcher`/`PgOutboxRelay`/`describeOutboxError` (the Oct-1 outbox lift `c94286c`). `pnpm typecheck` was green throughout — it reads `src/`, and `dist/` is gitignored. `pnpm dev` had no `dependsOn`, so `turbo run dev` launched `tsx watch src/main.ts` with no build step at all: the dev-boot proof was structurally unable to pass on an unbuilt tree | **Prevented at the root**: (1) `turbo.json` `dev.dependsOn: ["^build"]` — Turbo now compiles every dependency before launching a service; (2) `scripts/dev.sh` runs the build check first and refuses with the package name instead of burying it in interleaved output; (3) the checker no longer excuses a **value** missing from `dist` merely because the `.d.ts` still carries it (verified: stripping one value export from `dist/index.js` is now caught, where the previous version passed it). Reproduced end-to-end: with both packages reverted to a pre-Oct-1 shape the checker named both packages, `verify-submit-http-slice` failed with the identical `PgOutboxDispatcher` error, and after `pnpm build` the same proof and `verify-slot-integrity` both passed |

What this leaves for **your** Docker run to close: the Kafka-dependent proofs
(`verify-audit-slice`, `verify-event-driven`, `verify-vetting-slice`,
`verify-slot-assignment`, `verify-pipeline-e2e`, `verify-dead-letter`,
`verify-kafka-roundtrip`), the MinIO/ClamAV forensics proofs, and the 12-service
`verify-dev-boot.sh` — i.e. exactly Appendix A's non-Postgres rows, plus the aggregation
inside `pnpm verify`.

