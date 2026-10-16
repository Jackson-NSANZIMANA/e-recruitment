# USRP Delivery Programme — from today to a deployable pilot

**Status:** Proposed · 2026-10-16 · **Owner:** platform owner
**Verified against:** backend `main` 446f90b (+ `feat/rehearsal` 8943aec), frontend `main` e053479 (+ PR #27, `feat/rehearsal`)
**Companions:** [`000.md`](../../000.md) (handbook) · [`capability-map.md`](../architecture/capability-map.md) (what exists) · frontend `docs/architecture/frontend-revamp-plan-2026-10-15.md` (UI plan) · frontend `docs/product/user-facing-feature-spec-2026-10-15.md` (national baseline, go-live gates G1–G9)

This document divides the remaining work into **sessions**: bounded work packages that one engineer or agent can complete, prove and hand over. It also defines the protocol that lets several sessions run in parallel without breaking each other.

---

## 1. What we are building

One national recruitment process for RDF, RNP and RCS, expressed through three workspaces:
- the **Applicant Portal** for citizens;
- the **Officer Console** for agency administration, review queues and decisions;
- the **Field Station** for exam-day venues.

All three run on one authoritative backend: 12 services behind one edge (`/edge/v1/**`), an event backbone, and agency isolation enforced in PostgreSQL. The goal is not just to digitise forms. It is to make **every candidate and every field record provably accounted for**: when a registry is down, when a venue changes, when a device is lost, and when the network disappears (baseline §16).

## 2. Where it actually stands (verified 2026-10-16, not remembered)

### Backend — strong and proven
- **12 services**, about 35k lines, plus 9 shared packages (about 15k lines). Hexagonal design, zero-dependency HTTP substrate, transactional outbox, dead-letter handling.
- **68 live proofs pass in CI** on real PostgreSQL, Kafka, MinIO and ClamAV. They cover:
  - RLS isolation across agencies
  - the full BUILD-001 campaign control plane (P1–P17, populated upgrade, replayed bootstrap)
  - submission → age, NESA/HEC and RIB gates → slot → exam QR → single-use gate admission
  - walk-in lane, officer lifecycle (medical → final → accept), auto-withdrawal
  - erasure, retention sweep, edge boundary (session, CSRF, anti-enumeration, rate limits)
  - production boot guard and deployment hygiene

  One proof is skipped: direct provisioner authentication, which needs a secret CI does not have.
- **Rehearsal** (ADR-035, `feat/rehearsal`): `pnpm rehearse` stages a full synthetic cycle through the real control plane. A live cross-app journey passes on it.
- **The capability map is stale** on two points. BUILD-001 real-PostgreSQL acceptance is now proven in CI, and the campaign operations are in the frontend registry (as untyped IDs).

### Frontend — real screens exist, product breadth does not
- **Real screens:** onboarding, campaign-bound apply wizard (619 lines), exam pass, status list, officer list/detail with transitions, gate, walk-in.
- **All 16 feature-slice route files are one-line placeholders.** These include the amber queue, DPO queue, check-in, conflicts and invitation verifier.
- **Missing apps and surfaces:** no `field-station` app, no Campaign Studio, no admin or operations screens.
- **1 surface manifest** exists, of a planned one per route.
- **E2E:** under CI's configuration (production build), officer 16 and applicant 8 tests pass. The local `e2e/` configuration (two browser projects) runs 16 and 16. The live rehearsal journey is opt-in.
- **CI:** frontend `main` is **red** until PR #27 merges (the production build lost `VITE_EDGE_URL`).

### What is missing for deployability — engineering

| Area | State |
|---|---|
| **Deployment** | No Kubernetes, Helm, Terraform or production compose for the application. CI never builds, scans, signs or publishes an image. The SPAs have no serving image. |
| **Production adapters** | `LogSmsChannel` (identity, notification) and `MockBiometricMatcher` are **refused by the production boot guard**. Identity and notification services cannot start in production until a real SMS adapter exists. |
| **Observability** | Structured logs and `/health`/`/ready` only. No metrics, tracing or alerting. |
| **Resilience** | No backup, PITR or restore tooling. Kafka retention is not pinned in infra (ADR-019 flag). |
| **Operating the system** | No officer lifecycle API (create, assign posts, disable, revoke): "blocks operating ADR-031". No device revocation, audit browser, dashboards or exception desk. No operator relocation (baseline P1). |
| **Repository governance** | Both `main` branches are **unprotected**, with no required checks. That is how PR #26 merged with a red E2E. **Both repositories are public.** The August secret-rotation checklist (`docs/security/SECRET-ROTATION.md`) has every box unchecked. |

### What is missing for deployability — owner and external

| Item | State |
|---|---|
| SMS provider (MTN/Airtel) contract and credentials | Not started |
| G2G authorisation (NIDA, NESA, HEC, RIB) | Not started |
| Hosting and residency decision (Rwanda DC, two sites), KMS/HSM custody | Not started |
| Role and separation-of-duties ratification | Draft |
| DPIA, retention schedule, erasure SOP | Draft |
| Pilot agency and district; physical and medical standards; disclosure policy | Undecided |

## 3. What "deployable" means here

| Gate (baseline §15.11) | Today | Closed by sessions |
|---|---|---|
| G1 Release and contracts | 🟡 contracts strong; no tagged release or images | S00, S03 |
| G2 Domain integrity | 🟢 proven in CI (idempotency, slot integrity, outbox, history immutability) | regression only |
| G3 Identity and access | 🟡 boundary proven; no officer lifecycle, CAPTCHA/WAF or step-up | S01, S12, S16 |
| G4 Privacy, legal, residency | 🔴 drafts only | owner; S07 supplies the data-flow map |
| G5 Exam continuity | 🟡 signed pass, gate, walk-in; no relocation, paper fallback or assisted desk | S08, S14, S18 |
| G6 Reliability and recovery | 🔴 no SLOs, metrics, backups or drills | S11, S17 |
| G7 Field integrity | 🟡 server side proven; no field app; offline disabled | S08, S09, S15 |
| G8 Operational readiness | 🔴 no runbooks beyond E2E, no pilot | S18 + owner |
| G9 Release authorisation | 🔴 | owner, on evidence from all of the above |

## 4. How sessions cooperate

### 4.1 Shared state (read at start, update at end)
1. **`docs/architecture/capability-map.md`** (backend): the single truth of *what exists*. Every session that changes a capability updates its row in the same PR.
2. **This document, §6:** the session catalogue. A session marks itself `in progress` or `done`, with PR links.
3. **Frontend `frontend-revamp-plan`:** UI task status (W-IDs).
4. **CI on the merged commit** is the only accepted evidence. Local green is necessary, never sufficient (lesson of 2026-10-16).

### 4.2 The contract is the hand-off between backend and frontend
- **Single writer.** Only backend sessions add or change edge operations (`edge-operations.ts`, OpenAPI, upstream catalogue).
- **Consuming a new operation.** A frontend session consumes it **after it merges**, by re-pinning `EDGE_BACKEND_SHA` and regenerating contracts in one commit. The contract-drift gate must be green.
- **Unmerged contracts.** A frontend session may start against an *unmerged* contract only with intercepted specs, labelled `CONTRACT-PENDING: S0x`. It cannot merge until the contract does.

### 4.3 Ownership: parallel sessions must not edit the same files

| Owner session | Owns |
|---|---|
| Backend capability sessions | their service(s) under `services/*` and their migrations/RLS files (new numbered files only, never edit an applied one) |
| Frontend sessions | their slice(s) under `packages/features/*`, their app routes, their locale namespace |
| S03 / S07 / S11 | `.github/workflows`, `infrastructure/`, deployment manifests |

**Shared files** (`packages/shared-types`, `shared-auth/permissions.ts`, `packages/i18n/.../common.json`, `turbo.json`, root `package.json`) take **append-only** changes, in a separate small commit, rebased last.

### 4.4 Acceptance is a rehearsal, not a screenshot
Every user-facing capability ends with:
- a scenario step in `tools/rehearsal` (or a new scenario) that stages its data;
- a live spec step in `live-rehearsal.spec.ts` that drives it on the real stack.

The rehearsal library grows into the pilot's training and drill pack (S18).

### 4.5 Session ritual
- **Start:**
  1. Read `000.md`, the capability map, this document's card, and the relevant ADRs.
  2. `git pull`, then confirm both mains are green in CI.
  3. Boot the stack: `pnpm infra:up && pnpm dev && pnpm rehearse`.
- **During:**
  - one branch per session (`feat/sNN-<slug>`, `fix/…`, `docs/…`);
  - Conventional Commits with the attribution line;
  - never kill processes you did not start (developers run their own `pnpm dev`).
- **End:**
  1. All local gates pass, uncached.
  2. The live rehearsal journey passes, including the new step.
  3. A PR is open and **CI is green on the PR head**.
  4. The capability map and this card are updated.
  5. A hand-off note goes in the PR body: what changed, what the next session can now do, and any open risks.

### 4.6 Done means
Merged to `main` with green CI, capability map updated, rehearsal step passing, and no new `test.fixme` without a `BLOCKED:` reason.

## 5. Sequencing

```
Phase 0  S00 Programme integrity ─────────────────────────────── (serial, first)
            │
Phase 1  ├─ S01 Officer lifecycle (BE)      ├─ S02 Frontend foundations      ├─ S03 Release engineering
            │
Phase 2  ├─ S04 Read models I (BE)          ├─ S05 Campaign Studio (FE)       ├─ S07 Deployment topology + staging
         └─ S06 Officer workspace + queues + staff admin (FE, needs S01)
            │
Phase 3  ├─ S08 Field Station (FE, online)  ├─ S09 Fleet + venue ops (BE)     ├─ S11 Observability + backups
         └─ S10a Citizen timeline + notices (BE) → S10b Citizen completeness (FE)
            │
Phase 4  ├─ S12 Production integrations     ├─ S13 Operations product (BE+FE) ├─ S16 Security assurance
         ├─ S14 Operator relocation (BE+FE) ├─ S15 Durable offline capture     └─ S17 Load + failure drills
            │
Phase 5  S18 Pilot readiness pack ── go/no-go evidence for G1–G9
```

At most three sessions run in parallel. Each phase's sessions own disjoint paths (§4.3). A phase starts when its predecessors' contracts are merged, not when all of them are finished.

## 6. Session catalogue

Each card has: **Goal · Depends on · Owns · Delivers · Exit gate · Decisions needed.**

### Phase 0

**S00 — Programme integrity** *(both repos; first, alone)*

- **Goal:** a trustworthy baseline that cannot silently regress.
- **Delivers:**
  - merge PR #27 (frontend `main` green); open and merge the rehearsal PRs (backend `feat/rehearsal`, frontend `feat/rehearsal`);
  - **branch protection** on both mains: required checks (backend: typecheck, lint, proofs, security; frontend: Quality Gate), PR required, no force-push;
  - refresh the stale capability map rows, frontend `frontend-architecture.md` and `cross-repo-contract-reconciliation` (W0-01, W0-03), and rename the baseline document with errata;
  - **secret-rotation closure**: production secrets are generated only in KMS, never derived from any dev value; record the decision on a history rewrite; complete the checklist or record why an item does not apply;
  - write down the owner's decision on public repositories;
  - CI evidence bundle artefact: SHAs, operation inventory, test counts with skips separated (W0-04 remainder).
- **Exit gate:** both mains protected and green; the docs agree with the code.
- **Decisions needed:** repository visibility; history rewrite yes/no.

### Phase 1

**S01 — Officer lifecycle** *(backend: iam-service, edge; S06 builds the UI)*

- **Goal:** the permission model can be *operated*: the capability map's build-order #1.
- **Delivers:**
  - `agency_admin` can list officers, create an officer, assign and remove posts (roles), disable, and revoke sessions. All audited; separation-of-duties constraints are respected; no superadmin.
  - edge operations, OpenAPI, proofs (negative tests for cross-agency and self-escalation);
  - the rehearsal scenario provisions its station staff through the API instead of the seeder.
- **Exit gate:** proofs in `pnpm verify`; the rehearsal stages staff through the API.
- **Decisions needed:** the provisional role table stands until ratified; can an admin assign `decision_authority`?

**S02 — Frontend foundations** *(frontend; W0-06…W0-11)*

- **Delivers:**
  - the `apps/field-station` scaffold; gate and walk-in moved into the `field-ops` slice;
  - a surface manifest for every route, with the readiness ladder enforced by `surface:verify`;
  - contract-drift v2 (schemas, outcome unions, idempotency);
  - ADR-FE-007…013;
  - the `features/campaigns` slice and `packages/field-ledger` (ports and state machine, no UI).
- **Exit gate:** CI green; field-station builds and logs in; the officer and applicant suites still pass.

**S03 — Release engineering** *(CI and image definitions)*

- **Delivers:**
  - CI builds all 12 service images and 3 SPA images (a static server with CSP, HSTS and security headers, and SPA fallback that never caches `/edge`);
  - Trivy image scan, SBOM (CycloneDX), cosign signatures;
  - a tagged release produces the evidence bundle (baseline §15.1);
  - version attestation: each service exposes build SHA and policy/contract version.
- **Exit gate:** a tag yields signed, scanned images and an evidence bundle, reproducibly.

### Phase 2

**S04 — Read models I** *(backend)*

- **Delivers:**
  - admin campaign list in all states, plus session reads with occupancy (B-6);
  - officer application list with cursor, filters and total (BE-02);
  - venue/day roster read (B-5);
  - DPO queue and decision as edge operations (B-13);
  - `x-usrp-permission` and outcome unions in OpenAPI (BE-01).
- **Exit gate:** proofs, contract drift green on the frontend re-pin.

**S05 — Campaign Studio** *(frontend: campaigns slice, officer-console routes; W2-01/02)*

- **Delivers:** basics → policy (immutable version, hash shown, prefill labelled "suggestion") → district × day session grid → preflight with citizen preview → publish; lifecycle controls. Uses S04's list when merged (`CONTRACT-PENDING` before then).
- **Exit gate:** the live spec authors and publishes a campaign **through the UI**, and the applicant portal shows it.

**S06 — Officer workspace, queues, staff admin** *(frontend: applications, adjudication, compliance slices; W1-01…08)*

- **Delivers:**
  - `packages/ui` state patterns (`StateBoundary`, `QueueTable`, `ConfirmAction`, `Timeline`, `MaskedValue`);
  - Applicant 360; amber and hold queues; medical and final queues; permission-built navigation;
  - staff administration screens on S01;
  - DPO queue on S04; paper-fallback print sheets (W1-08).
- **Exit gate:** the reference workspace is E2E-proven; queues are live in the rehearsal journey.

**S07 — Deployment topology and staging** *(infrastructure)*

- **Delivers:**
  - runtime chosen and recorded as an ADR (Kubernetes + Helm, or compose for the pilot);
  - manifests, secrets from KMS/Vault, TLS and ingress with the edge as the single origin;
  - managed or operated PostgreSQL, Kafka and MinIO with pinned retention; network policies;
  - a **staging environment** deployed from S03 images, with `pnpm rehearse` runnable against it (an adjusted fence);
  - the data-flow and residency map for the DPO (G4 input).
- **Exit gate:** staging is deployed by pipeline, and the rehearsal journey passes on staging.
- **Decisions needed:** hosting (Rwanda data centre), KMS custody, domain names.

### Phase 3

**S08 — Field Station, online-first** *(frontend: field-station, field-ops, scheduling slices; W2-08…12)*

- **Delivers:**
  - device setup, readiness check and enrolment (WebCrypto key);
  - permission-derived station picker;
  - gate with paper-document sighting; physical capture through `field-ledger` (local-first, sent online, per-record acknowledgement);
  - medical (agency mode); supervisor conflicts; offline signature verification as the degraded rung.
- **Exit gate:** the rehearsal journey runs through the **field-station** app: admit → physical → medical.

**S09 — Fleet and venue operations** *(backend)*

- **Delivers:** device list, assign, revoke and last-seen (B-4); venue live counts feed (T11); a review of field-ledger acknowledgement semantics against field-sync.
- **Exit gate:** a revoked device is refused on next contact (proof).

**S10a — Citizen timeline and notices** *(backend: BUILD-005)*

- **Delivers:** a citizen-safe status history with per-gate state (B-2), and a per-applicant notification log with delivery state (B-8).

**S10b — Citizen completeness** *(frontend)*

- **Delivers:** campaign catalogue and detail pages; document checklist screen; six-stage tracker; privacy centre; notice inbox.

**S11 — Observability and resilience** *(infrastructure plus shared packages)*

- **Delivers:**
  - OpenTelemetry traces and metrics (correlation ID already flows), dashboards, alerts;
  - log shipping that preserves `shared-logging` redaction;
  - SLO definitions (baseline §15.8 proposals);
  - backups, PITR, a **restore drill with checksums**, and a DR runbook.
- **Exit gate:** restore proven on staging with a measured RPO/RTO.

### Phase 4

**S12 — Production integrations** *(backend)*

- **Delivers:**
  - an SMS provider adapter behind `SmsChannel`, with a cost cap and delivery receipts;
  - G2G production mode (credentials from KMS, call budgets, timeouts, circuit breaking, supervised manual lane);
  - CAPTCHA/WAF on anonymous onboarding;
  - the biometric decision implemented (manual-admission policy, with biometric-service excluded from the deployment).
- **Exit gate:** identity and notification services boot under `NODE_ENV=production` on staging.
- **Blocked by:** the provider contract and G2G authorisation.

**S13 — Operations product** *(backend + frontend; BUILD-006)*

- **Delivers:** dashboard projection (B-1) and the command dashboard; audit explorer (B-10); exception desk and stuck-application view; emergency campaign suspension.

**S14 — Operator relocation and rescheduling** *(backend + frontend; baseline P1)*

- **Delivers:**
  - an ADR;
  - superseding reservations with invalidation of old passes (including the offline revocation window);
  - replacement invitations and notices;
  - a console flow;
  - the rehearsal scenario `venue-down`.

**S15 — Durable offline capture** *(frontend + backend review; Wave 4)*

- **Delivers:**
  - an encrypted durable queue on the managed-device target;
  - replay with idempotency; restart, eviction, clock and key-rotation drills;
  - `OFFLINE_CAPTURE_CAN_SYNC` flips only alongside the proof.

**S16 — Security assurance**

- **Delivers:**
  - a threat model; an ASVS L2 review pack;
  - an authorisation negative-test matrix (every role × operation × agency);
  - anonymous-surface sign-off; a third-party penetration-test package.

**S17 — Load and failure drills**

- **Delivers:**
  - k6 tests built on rehearsal personas;
  - a spike at 3× the approved scenario, a 24-hour soak;
  - database failover, Kafka broker loss, and registry/SMS outage drills on staging, with measured results.

### Phase 5

**S18 — Pilot readiness pack**

- **Delivers:**
  - rehearsal scenarios for every drill (normal day, registry outage, device loss, venue relocation, closeout);
  - trilingual staff scripts; the assisted-desk procedure;
  - the paper fallback kit;
  - a go/no-go evidence bundle mapping G1–G9.
- **Exit gate:** the owner's go/no-go review.

## 7. Owner and external decision calendar

| Needed before | Decision |
|---|---|
| S00 | Repository visibility; history rewrite for the August `.env` exposure |
| S01 / S06 | Role table ratification (provisional until then); who may assign `decision_authority` |
| S07 | Hosting provider and residency (two sites in Rwanda proposed); KMS/HSM custody; domains |
| S08 | Pilot agency and district (fixes the medical mode); paper fallback procedure; device fleet (managed Android model) |
| S12 | SMS provider contract; G2G authorisations; biometric policy |
| S14 | Relocation authority and fairness rules |
| S18 | DPIA, retention and erasure SOP signed; SLOs, RPO and RTO ratified; go/no-go authority |

**The external items (SMS, G2G, hosting) have the longest lead times.** They should start now, in parallel with Phase 1, or Phase 4 will stall on them.

## 8. Kickoff prompt template

Paste into a new session, filling the card:

> You are working on USRP (national GoR e-recruitment). This is session **SNN — <title>** of `docs/program/delivery-programme.md` (backend repo).
> 1. Read `000.md`, `docs/architecture/capability-map.md`, §4 and your card in the programme, and the ADRs it names.
> 2. Confirm both `main` branches are green in CI; boot the stack (`pnpm infra:up && pnpm dev && pnpm rehearse`).
> 3. Work only within your card's ownership; follow §4.2 for contract changes.
> 4. Done means: local gates uncached, live rehearsal step passing, PR with green CI, capability map and card updated, hand-off note in the PR.

## 9. Risks to the programme

| Risk | Mitigation |
|---|---|
| External dependencies (SMS, G2G, hosting) arrive late | Start in Phase 1; S12 is designed behind existing ports, so only adapters change |
| Parallel sessions collide on shared files | §4.3 ownership; shared files append-only, rebased last; at most three sessions in parallel |
| Local green ≠ CI green | §4.6: CI on the PR head is the definition of done; branch protection (S00) enforces it |
| Mocked specs hide contract gaps (W1-09) | §4.4: every capability gets a live rehearsal step |
| Docs drift from code (the capability map was stale within a day) | The same PR updates the docs; S00 adds the CI evidence bundle so counts and SHAs are never hand-written |
