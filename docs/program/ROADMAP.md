# USRP Engineering and Architecture Roadmap

**Status:** Adopted · 2026-10-21 · **Owner:** platform owner
**Verified against:** backend `main` 17306af (B1 merged; `v0.1.0-rc1` tagged at 4546cee), frontend `main` (S02 and S03 merged) · **Ledger updated:** 2026-10-21
**Supersedes for sequencing:** `delivery-programme.md` §5 (phases), national baseline §13 (waves 0–6), frontend revamp plan "Waves 3–6". Those documents keep their detail (session cards, feature catalogue, gate definitions); **this file decides order and priority**.

This is the single roadmap for USRP. Every session, ADR and PR is placed against it. It is meant to be **stable**: milestones, principles and gates change only by the amendment rule in §9. Day-to-day progress is not written here: it lives on the [status board](README.md#status-board) and in the CI evidence bundle. The only progress recorded here is the **milestone ledger** (§3.1), an append-only record of proofs that have passed.

---

## 1. Vision

One national recruitment process for RDF, RNP and RCS, through three workspaces (Applicant Portal, Officer Console, Field Station), on one authoritative backend. The goal is not to digitise forms. It is to make the process **provable**.

The governing test (baseline §16), which every milestone is measured against:

> Can we prove, from a tagged build, what happened to every candidate and every field record, even when a registry is down, a venue changes, a device is lost or the network disappears?

North star: one authoritative application lifecycle; one versioned policy per filing; one audit trail; three role-appropriate views of the same truth.

## 2. Principles (binding)

1. **Milestones are proofs, not feature lists.** A milestone closes when its named rehearsal scenarios pass on a real stack and its go-live gates (G1–G9, baseline §15.11) have evidence. Screens shipped do not close milestones.
2. **Operability before breadth.** Work that lets a real exam day run safely (paper fallback, relocation, assisted desk, reconciliation) comes before work that makes the product broader.
3. **Fallbacks are first-class features.** Every automated step has a supervised manual lane: registry down, OTP failed, biometric no-match, device lost, venue unusable. An upstream failure is never a candidate failure.
4. **Nothing claims a capability it has not proven.** `OFFLINE_CAPTURE_CAN_SYNC` stays `false`, biometrics stay `SHADOW`, and readiness rungs (ADR-FE-009) stay where the evidence puts them.
5. **The contract is the hand-off.** Only backend sessions change `openapi/edge-v1.yaml`; every officer operation carries `x-usrp-permission` and `x-usrp-outcomes` (ADR-039); the frontend consumes merged contracts only.
6. **Agency isolation is not negotiable.** Cross-agency figures come only from a separately governed, aggregate-only projection. No general cross-agency read path is ever added.
7. **Done means CI green on the PR head** (quality-workflow.md). Local green, cached green and mocked green are not evidence.
8. **External lead times are on the critical path.** Owner and external decisions (§6) are tracked with the same weight as engineering work.

## 3. Milestones

| Milestone | Meaning | Work packages | Closing proof | Gates |
|---|---|---|---|---|
| **M0 Foundations** — closed | Repos honest, protected and releasable | S00, S01, S02, S03, S04 · `v0.1.0-rc1` | Mains protected with required checks; evidence bundle on every run; signed images; officer lifecycle and read models live | G1 (part) |
| **M1 Staff run the system** | Every rehearsal step is possible through the UI, without engineers | S06 (two PRs: shared `@usrp/ui` states first), S05 minimal Campaign Studio, B1 in `SHADOW` | Rehearsal driven through the UI: a Studio-published campaign has the same policy hash as `pnpm rehearse`; staff created, posted, disabled through S06; the DPO queue decided in the console | G2, G3 (part) |
| **M2 An honest exam day** | One agency, one district, one venue: online capture plus rehearsed paper | S09 roster + fleet, S08 Field Station (online), **S14 operator relocation**, paper kit and assisted desk (pulled forward from S18) | Rehearsal scenarios `normal-day`, `venue-down`, `device-lost`, `registry-down` pass; end-of-day reconciliation of digital and paper records is exact | G5, G7 (online) |
| **M3 It runs somewhere real** | Production-mode staging that is observable and recoverable | S07 staging (provider-neutral), S11a observability, S11b backup + restore, S12 SMS + G2G adapters, S10a → S10b citizen timeline, minimal S13 control room | Identity and notification boot with `NODE_ENV=production` on staging; restore drill with measured RPO/RTO; alerts fire on injected faults; citizen tracker on real projections | G1, G3, G6 |
| **M4 Pilot go/no-go** | Evidence, not confidence | S16 security assurance, S17 load + failure drills, S18 pilot pack, training, DPO/legal sign-off | Spike at 3× the approved scenario and 24-hour soak pass; signed G1–G9 bundle; synthetic cohort, then a limited authorised live cohort | G4, G8, G9 |
| **M5 National scale** | Expand only from measured pilot data | S15 durable offline / native client, B2 + B3 biometrics to `ADVISORY`, full S13 (dashboards, audit explorer), governed national aggregates, USSD, applicant-requested rescheduling, read-only AI assistance | Each expansion stage has rollback and stop authority; offline sync flips only with its proof (G7) | G7 (offline) |

Milestones overlap in time: a later milestone's packages may start once their dependencies merge. But **a milestone is not reported as reached until all of its proofs pass**, and M4 cannot open while M2 or M3 proofs are missing.

### 3.1 Milestone ledger (append-only)

A row is added when a proof passes in CI on `main`, citing the PRs. Rows are never edited or removed; a regression adds a new row.

| Date | Milestone | Proven | Evidence |
|---|---|---|---|
| 2026-10-18 | M0 | Both mains protected (required checks, strict, admins included); CI evidence bundle on every run; secret rotation closed | BE #34 #35 #36 · FE #27 #28 #29 |
| 2026-10-18 | M0 | Rehearsal: a synthetic cycle staged through the real control plane; persona A admitted at the gate, persona B refused on age | BE #35 (ADR-035) · FE live journey |
| 2026-10-19 | M0 | Officer lifecycle: create/activate, posts, disable/enable, session revocation (rls/0033) | BE #39 (ADR-036) |
| 2026-10-21 | M0 | Release engineering: digest-pinned signed images, `GET /version`, unit-test gate required, release bundle; SPA serving images | BE #38 · FE #32 #34 · tag `v0.1.0-rc1` |
| 2026-10-21 | M0 | Frontend foundations: three apps (field-station added), readiness ladder enforced, contract drift v2 | FE #33 (ADR-FE-007…013) |
| 2026-10-21 | M0 | Read models: agency campaign list/detail with occupancy, paginated application search with totals, minimal venue roster, DPO queue and decision on the edge; permission and outcome metadata on every officer operation, enforced | BE #41 (ADR-039, rls/0035) |
| 2026-10-21 | **M0 closed** | All M0 packages merged with CI green on `main` | — |
| 2026-10-21 | M1 (part) | Biometric identity evidence in `SHADOW`: device-signed, PII-free, append-only; never a verdict; supervised manual identity after `NO_MATCH`; no image accepted | BE #40 (ADR-037, rls/0034) |

**Where M1 stands:** B1 is done. S06 and the minimal S05 remain, and so does the closing proof: the rehearsal driven entirely through the UI.

## 4. Changes from the earlier plans, and why

| Change | Why |
|---|---|
| **S14 relocation, paper fallback and the assisted desk move into M2** (were Phase 4 / Phase 5) | Baseline binding decisions 6, 8 and 9 make them pilot requirements. Without them there is no honest exam day. |
| **The pilot runs online with paper fallback; S15 durable offline moves to M5** | A connected pilot venue plus rehearsed paper is safer than an unproven browser-storage queue. Baseline decision 5 and ADR-FE-010 forbid claiming offline sync before restart, eviction, replay and closeout proof. |
| **Biometrics leave the critical path: B1 stops at `SHADOW`; B2 and B3 are M5** | Manual photo comparison is the identity baseline (decision 4). B2 needs a licensed model and B3 an evaluation dataset, neither of which should hold the pilot. |
| **S07 builds provider-neutral staging now; residency governs production only** | The hosting decision would otherwise freeze M3. Staging needs no real personal data; G4 applies before live data. |
| **S11a runs in any free lane from now** | It depends only on S03 (merged) and needs no owner decision. |
| **A minimal S13 control room is in M3** | G8 requires a control room at the pilot; the full dashboard waits for M5. |
| **S10a/S10b moved to M3** | Citizens need truthful status before the pilot (baseline B-2 is P1), but it does not block running an exam day. |

## 5. Architecture runway

These decisions must be made, as ADRs, **before** the work package that needs them starts. The ADR number is reserved at that time in README.md.

| Decision | Needed before | Direction |
|---|---|---|
| **Read-model strategy for dashboards** | S13 | S04 answers lists with indexed queries (ADR-039). Dashboards need event-fed projection tables with declared freshness, rebuildable from the outbox. National figures use a governed aggregate-only projection with small-cell suppression (principle 6). |
| **Pilot deployment profile** | S07 | Keep service boundaries in code. Evaluate a consolidated pilot profile (fewer processes, `biometric-service` excluded, as S12 already assumes) against the operating burden of 12 services + Kafka + PostgreSQL + MinIO + ClamAV for a single-district pilot. |
| **Key custody and rotation** | S07, S12 | QR (`USRP-SLOT.v1`), session-token and device signing keys move to KMS/HSM, with rotation and compromise drills. Offline revocation window defined for S14 superseded passes. |
| **Version and policy attestation** | S11a, S08 | Extend `/version` (ADR-038) so every service and device reports build, policy hash and key version; version skew becomes a measured signal (G8). |
| **Relocation and superseding invitations** | S14 | Superseding reservation; old pass invalid on the server and, within a bounded window, at offline verifiers; replacement notice; capacity and audit reconciled. |
| **Production integration envelopes** | S12 | Per-provider call budgets, timeouts, circuit breakers and a supervised manual lane for NIDA, NESA, HEC, RIB and SMS. A rate-limited registry yields `pending`, never a negative verdict. |
| **Durable field ledger on the native target** | S15 | ADR-FE-010's storage interface backed by an encrypted database and hardware-backed key; the managed Android PWA stays the pilot target. |

## 6. Critical path: owner and external decisions

Ordered by lead time. Engineering cannot shorten these.

| # | Decision | Owner | Blocks |
|---|---|---|---|
| 1 | SMS provider contract and credentials; G2G authorisation (NIDA, NESA, HEC, RIB) | Platform owner, agencies | M3 (S12) |
| 2 | Pilot agency, district and managed tablet model | Agencies, field operations | M2 (S08) |
| 3 | Paper fallback procedure, relocation authority, assisted-desk operation | Recruitment operations | M2 |
| 4 | Hosting, Rwanda residency (two sites proposed) and key custody | Platform owner, DPO, security | Production only (G4); staging proceeds |
| 5 | DPO sign-off: DPIA, ADR-037 biometrics, retention schedule, erasure SOP | DPO, legal | M4 |
| 6 | Role and separation-of-duties ratification; physical and medical standards; rejection disclosure and appeal policy | Agency leadership, legal | M4 |
| 7 | SLOs, RPO and RTO ratified (baseline §15.8 proposals) | Platform owner | M4 (S17) |
| 8 | ADS licence: written clearance or a migration decision (ADR-FE-008 accepted risk) | Legal | Public launch |
| 9 | Biometric model licence and evaluation dataset | Platform owner, DPO | M5 (B2, B3) |

## 7. Cross-cutting work no session owned before

| Work | Milestone | Owner |
|---|---|---|
| Native-speaker review of Kinyarwanda and French strings | M3 | S10b, then every frontend session |
| Accessibility audit to WCAG 2.2 AA (automated checks cover 3 stories today) | M3 | S06 adds stories; S16 audits |
| Training material for the field roles (gate, paper documents, physical, medical, supervisor, assisted desk, control room) | M4 | S18 |
| Trilingual incident and outage messages | M4 | S18 |
| Rehearsal scenario per drill, growing with each milestone | M1–M4 | each session adds its scenario |

## 8. How the work ahead is run

### 8.1 Lanes

- **Two concurrent agent sessions at most** (usage limits), plus an infra-only lane when one is free.
- Two backend sessions do not run against the shared append-only files at once without staggered merges (README §Shared files). The later one rebases onto main and re-proves itself before merging (§8.4).
- **Models:** Opus for the biometric track (B1–B3) and security-heavy work (S16). Sonnet for the other sessions.

### 8.2 Session plan per milestone

| Milestone | Session | Kit | Lane | Needs from the owner first |
|---|---|---|---|---|
| M1 | **S06** officer workspace + staff admin (two PRs; carries the four-eyes activation-code fix) | ready | FE | — |
| M1 | **S05** minimal Campaign Studio (draft → policy → sessions → publish; policy-hash parity with the rehearsal) | ready | FE | — |
| M2 | **S09** venue roster + device fleet (rls/0036) | ready | BE | who may enrol and revoke devices |
| M2 | **S08** Field Station, online capture | ready | FE | pilot agency, district, tablet model |
| M2 | **S14** operator relocation and superseding invitations | **to write** | BE+FE | relocation authority and fairness rules |
| M2 | **P1 pilot continuity kit** (new package): printed roster and run sheet from `getVenueRoster`, paper score sheets with two-person re-entry and reconciliation, assisted desk with pass printing | **to write** | FE + procedure | paper procedure; assisted-desk operation |
| M3 | **S11a** observability (any free lane, from now) | ready | infra | — |
| M3 | **S07** provider-neutral staging → **S11b** backup + restore | ready | infra | production hosting only |
| M3 | **S12** SMS + G2G production adapters | **to write** | BE | provider contract; G2G authorisation |
| M3 | **S10a → S10b** citizen timeline and screens | ready | BE → FE | — |
| M3 | **S13 (minimal)** control room: exam-day live and field-health panels | **to write** | BE+FE | — |
| M4 | **S16** security assurance · **S17** load + failure drills · **S18** pilot pack | **to write** | mixed | SLOs, RPO/RTO; DPO sign-off; role ratification |
| M5 | **S15** durable offline · **B2 → B3** biometrics · full S13 | S15 to write; B2–B3 ready | mixed | model licence; evaluation dataset |

A kit marked **to write** is written, and its ADR and migration numbers are reserved in README.md, before the session starts. Kits are written one milestone ahead, never further.

### 8.3 Immediate order

1. **S06 ‖ S09** — start now.
2. **S08 ‖ S14**, once the pilot agency, district and tablet are decided (§6 #2–3). The S14 and P1 kits are written while S06 and S09 run.
3. **S05** and **S11a** in whichever lane frees first.
4. M3 packages: S07 → S11b; S12 when the contracts arrive; S10a → S10b; minimal S13.

### 8.4 Session practice (learned in M0)

- **Commit and push early.** A session can stop at any moment (usage limits, restarts). Work that is committed but not pushed is easy to lose, and so is a rebase that was never pushed.
- **Re-prove after every rebase.** B1 and S04 each passed CI alone. Combined, they conflicted in ways git didn't flag: missing contract metadata, and a newly required config field. The later session reruns the contract, schema-drift and its own proofs on the rebased head.
- **Proofs on throwaway databases set both connections.** Set both `DATABASE_URL` and `ADMIN_DATABASE_URL`; otherwise the admin connection defaults to the shared `usrp_db`.
- **A resumed session starts from the pushed branch,** never from a memory of it. It reads `git log origin/main..HEAD` against the kit's Done list.

## 9. Amending this roadmap

- A change to a milestone's meaning, closing proof, gates or the principles needs a PR that edits this file and states why, approved by the platform owner.
- Moving a work package between milestones is allowed in the same way, with the reason in §4.
- Session progress belongs on the status board and in the CI evidence bundle, so this file does not go stale. The exceptions are the §3.1 ledger, which is append-only, and the kit column of §8.2, which is updated when a kit is written.
- If another document disagrees with this file on order or priority, this file wins; fix the other document in the same PR that notices it.
