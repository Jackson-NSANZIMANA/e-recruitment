# S02 — Frontend foundations

**Phase 1 · frontend · depends on S00** · Branch `feat/s02-foundations` · Reserved: **ADR-FE-007…013**

## Why
Every later frontend session (S05, S06, S08, S10b, B2) builds on this one. It provides:
- the third app (`field-station`);
- the readiness ladder that keeps unbuilt screens out of production;
- contract-drift checks that compare schemas, not just paths;
- the `campaigns` slice and the `field-ledger` package these sessions will fill.

Seven placeholder screens are reachable today (see the [README table](../README.md#placeholder-screens--which-session-replaces-each)). S02 stops that.

## Read first (frontend repo)
1. `AGENTS.md` (invariants, ADS ladder, package boundaries)
2. `docs/architecture/frontend-revamp-plan-2026-10-15.md` §2 (target architecture) and §4 (W0-06…W0-11)
3. `docs/architecture/adrs-fe/*` (FE-001…006)
4. `apps/officer-console/src/{app.tsx,routes/slices.tsx,main.tsx}`, `apps/officer-console/vite.config.ts`, `playwright.config.ts`
5. `tooling/surface-contract/` (schema and verifier), `docs/ui-surfaces/officer.application-workspace.json`
6. `tooling/contract-drift/` and `packages/contracts/README.md`

## Preconditions
```bash
cd ~/Documents/projects/e-recruitment-software/e-recruitment-ui && git switch main && git pull
gh run list --branch main --limit 1          # green (S00 merged #27)
pnpm install && ls apps/*/.env               # VITE_EDGE_URL needed for production builds
```

## Owns
- `apps/field-station/**` (new)
- `packages/features/field-ops/**` (structure; S08 fills the screens)
- `packages/features/campaigns/**` (new, scaffold only)
- `packages/field-ledger/**` (new)
- `tooling/surface-contract/**`
- `tooling/contract-drift/**`
- `docs/ui-surfaces/**`
- `docs/architecture/adrs-fe/ADR-FE-007…013`
- `tooling/repo-hygiene/check-boundaries.mjs` (field-station and field-ledger rules)

**Append-only:** `turbo.json`, `.github/workflows/ci.yml`, `pnpm-workspace.yaml` (apps/* already covers it), `apps/*/src/routes/slices.tsx`.

## Work plan
1. **ADRs FE-007…013**, as titled in the revamp plan §3:
   - 007 three-app topology
   - 008 ADS retained, risk owner-accepted
   - 009 readiness ladder
   - 010 field-ledger
   - 011 station model
   - 012 contract parity v2 and the evidence bundle
   - 013 citizen stage projection
2. **`apps/field-station`**, mirroring officer-console:
   - eager login, `OfficerGuard`, i18n, AppProvider, `resolveAdsFeatureFlag`, StrictMode, router v7 flags;
   - PWA with `NetworkOnly` for `/edge`;
   - the `VITE_EDGE_URL` build guard;
   - port **3002**; manifest `orientation: landscape`;
   - its own size budget in `check-bundle-size.mjs`;
   - a CI E2E project.
3. **Move gate and walk-in** (`apps/officer-console/src/{routes/gate.tsx,gate/*,routes/walk-in.tsx,walk-in/*}`) into `packages/features/field-ops`. Field-station mounts them. Officer-console redirects `/gate` and `/walk-in` to a "use the Field Station" notice. Keep the existing specs passing, moved with the code.
4. **Readiness ladder** (W0-07):
   - add `readiness` (rung plus evidence) to `surface-contract.schema.json`;
   - write a manifest for **every** mounted route in all three apps;
   - `surface:verify` enforces each rung's evidence (E2E-PROVEN = the referenced spec exists and has no fixme/skip);
   - **production builds mount only routes at SCREEN-BUILT or above.** Placeholder routes stay available in dev, behind a visible "not built" banner. This retires the seven reachable placeholders from production without deleting work in progress.
5. **Identity placeholders.** Decide in ADR-FE-007: move both apps' login pages into `features/identity` (preferred; one implementation, three apps), or delete the dead placeholders.
6. **Contract drift v2** (W0-06): compare request/response schemas, outcome unions (409/422) and idempotency scope. Add a failing fixture for each new dimension in the selftest. The permission comparison waits for S04's `x-usrp-permission`.
7. **Scaffolds:**
   - `features/campaigns`: model and api adapter over the 7 campaign operations; typed operations in `api-client` (`createCampaign` … `cancelCampaign`) with wire types from `edge-v1.yaml`;
   - `packages/field-ledger`: `StoragePort` (IndexedDB adapter with `navigator.storage.persist()`), `SignerPort` (WebCrypto Ed25519, non-extractable), the record envelope and the client sync state machine (`LOCAL_ONLY → QUEUED → SENDING → ACCEPTED | DUPLICATE_REPLAY | REJECTED_VALIDATION | STALE_CONFLICT → NEEDS_SUPERVISOR → RESOLVED`), pure-tested. **No UI.**
8. **Boundary rules:**
   - `field-ledger` imports no feature;
   - field-station composes only `identity`, `scheduling`, `field-ops` and the `applications` model.

## Quality bar
- Uncached typecheck, lint, test and build with the task counts shown; `CI=1 pnpm test:e2e` across **all three apps**
- `surface:verify` reports a real rung for every route
- Boundary checks green
- Bundle sizes within budget; ADS a11y green

## Exit gate
- [ ] Field-station builds, logs in on the real stack, shows the station picker shell, and runs the gate from its new home (live rehearsal persona A admitted **from field-station**).
- [ ] A production build of officer-console contains none of the seven placeholder screens (an E2E asserts 404 or not-built).
- [ ] Contract drift v2 selftest proves each new dimension can fail.
- [ ] CI green on the PR head; ADRs merged; status board updated; S05, S06 and S08 unblocked.

## Owner decisions (ask; default if no answer)
| Decision | Default |
|---|---|
| Field-station port and domain naming | port 3002, `field.<domain>` |
| Keep placeholder routes visible in dev? | yes, with a banner |

## Hand-off
- Where each moved file now lives.
- How to mount a slice route in field-station.
- How to declare readiness.
- The field-ledger API surface (for S08).

## Session starter
```text
You are the principal frontend engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Frontend repo: ~/Documents/projects/e-recruitment-software/e-recruitment-ui; backend (read-only for you): ../e-recruitment.

This is session S02 — Frontend foundations. Read your kit e-recruitment/docs/program/sessions/S02-frontend-foundations.md, then the backend's docs/program/README.md and quality-workflow.md, then the frontend AGENTS.md, and follow them.

Goal: a third app apps/field-station (gate and walk-in moved into the field-ops slice and running there), a readiness ladder in surface manifests for every route that keeps unbuilt screens out of production builds, contract-drift v2, a typed campaigns slice scaffold, a pure-tested field-ledger package, and ADR-FE-007..013.

Use only your reserved ADR numbers. Prove the live rehearsal journey still admits persona A — now from field-station. Done = CI green on the PR head with all three apps' E2E, status board updated, hand-off note in the PR.
```
