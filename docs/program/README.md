# USRP sessions — how to run the programme

**Order and priority are set by [`ROADMAP.md`](ROADMAP.md)** (milestones M0–M5); it wins over any other document on sequencing. Session cards are in [`delivery-programme.md`](delivery-programme.md). The rules for every session are in [`quality-workflow.md`](quality-workflow.md). Each session has a self-contained kit in [`sessions/`](sessions/) that ends with a **Session starter**: paste it into a new Claude Code session opened at `~/Documents/projects/e-recruitment-software`.

## Order

> The phase diagram below is the original session dependency graph. For what runs next and why, follow [`ROADMAP.md`](ROADMAP.md) §3 and §8 (notably: S14 relocation and the paper/assisted-desk kit are pilot work in M2; S15 offline and B2/B3 are M5).

```
Phase 0  S00 Programme integrity                                     (alone)
Phase 1  S01 Officer lifecycle (BE) │ S02 Frontend foundations │ S03 Release engineering
         └── B1 Biometric evidence (BE) — starts when S01 merges (shared edge files)
Phase 2  S04 Read models (BE) │ S05 Campaign Studio │ S06 Officer workspace + staff admin
         S07 Deployment + staging (infra only; may run as a 4th lane)
Phase 3  S08 Field Station │ S09 Fleet + venue ops (BE) │ S10a Citizen timeline (BE) → S10b Citizen screens
         S11a Observability │ S11b Backup + restore (infra lanes)
         B2 Biometric capture on the Field Station (needs S08 + B1) → B3 Biometric evaluation + shadow mode
```

**Concurrency:** at most three code sessions at once, plus one infrastructure-only lane. Within a phase, start a session as soon as the sessions in its *Depends on* list have **merged**, not when the whole previous phase is finished.

## Placeholder screens — which session replaces each

All 16 feature-slice route files in `e-recruitment-ui/packages/features/*/src/routes` are one-line placeholders. Seven are **reachable today** (✱). S02 stops any unbuilt route from mounting in production, and each owning session replaces its own.

| Route file | Mounted at | Owner |
|---|---|---|
| adjudication `index`, `amber-queue` ✱ | officer `/adjudication/amber-queue` | S06 |
| applications `list`, `detail` | not mounted (the app owns `/applications`) | S06 (move the workspace into the slice) |
| compliance `index`, `dpo-queue` ✱ | officer `/compliance/erasure-queue` | S06 (needs S04's DPO edge operations) |
| compliance `withdraw` ✱ | applicant `/my/withdraw` | S10b |
| field-ops `index`, `check-in` ✱, `conflicts` ✱, `walk-in` ✱ | officer `/field/*` | S02 moves them to field-station; S08 builds them |
| identity `index`, `citizen-otp`, `officer-login` | not mounted (the apps own their logins) | S02 decides: move the logins into the slice, or delete the dead placeholders |
| scheduling `index`, `verify-invitation` ✱ | officer `/scheduling/verify-invitation` | S08 (offline verifier as the gate's degraded rung) |

## Reserved numbers

Parallel sessions must not pick "the next number". These are reserved; use only your own.

| Session | Backend ADR | RLS file (`packages/shared-database/src/rls/`) | Frontend ADR |
|---|---|---|---|
| S01 | ADR-036 officer lifecycle | `0033_officer_lifecycle.sql` | — |
| B1 | ADR-037 biometric identity evidence | `0034_biometric_evidence.sql` | — |
| S02 | — | — | ADR-FE-007…013 (per the revamp plan) |
| S03 | ADR-038 release and supply chain | — | ADR-FE-014 SPA serving image |
| S04 | ADR-039 operational read models | `0035_operational_reads.sql` | — |
| S05 | — | — | ADR-FE-015 Campaign Studio |
| S07 | ADR-040 deployment topology | — | — |
| S08 | — | — | ADR-FE-016 field ledger and stations (if it deviates from FE-010/011) |
| S09 | — | `0036_device_fleet.sql` | — |
| S10a | ADR-041 citizen timeline and notices | `0037_citizen_timeline.sql` | — |
| S11a | ADR-042 observability | — | — |
| S11b | ADR-043 backup and recovery | — | — |
| B2 | — | — | ADR-FE-017 on-device biometric pipeline |
| B3 | ADR-044 biometric evaluation and thresholds | — | — |
| S14 | ADR-045 relocation and superseding invitations | `0038_relocation.sql` | — |
| P1 | ADR-046 paper records and reconciliation | `0039_paper_continuity.sql` | ADR-FE-018 paper and assisted-desk screens |
| S12a | ADR-047 G2G production sandbox | `0042_national_id_hint.sql` | — |
| S12b | ADR-048 identity binding and Irembo clearance | `0040_clearance_certificates.sql` | — |
| S12c | ADR-049 campaign policy v2 | `0041_campaign_policy_v2.sql` | ADR-FE-019 sandbox presentation and NIDA pre-fill |

`ADR-035` is the rehearsal ADR (backend `feat/rehearsal`, merged in S00). Drizzle migrations, if needed, use the next free `000N_*.sql` **at rebase time**. Migrations are linear by design, so the later session renumbers its migration before merging.

## Shared files (append-only, separate commit, rebased last)

**Backend:**
- `packages/shared-types/src/*.ts`
- `packages/shared-auth/src/permissions.ts`
- `services/edge-gateway/src/domain/{edge,upstream}-operations.ts`
- `services/edge-gateway/src/routes.ts`
- `openapi/edge-v1.yaml`
- `scripts/run-selfchecks.sh`
- `scripts/bootstrap-db.sh`
- `turbo.json`, `package.json`

**Frontend:**
- `packages/api-client/src/{paths,wire,index}.ts`
- `packages/i18n/src/locales/*/common.json`
- `apps/*/src/routes/slices.tsx`, `apps/*/src/app.tsx`
- `turbo.json`, `.github/workflows/ci.yml`

## Status board

| Session | State | PR(s) | Notes |
|---|---|---|---|
| S00 Programme integrity | done | BE [#34](https://github.com/Jackson-NSANZIMANA/e-recruitment/pull/34) [#35](https://github.com/Jackson-NSANZIMANA/e-recruitment/pull/35) [#36](https://github.com/Jackson-NSANZIMANA/e-recruitment/pull/36) · FE [#27](https://github.com/Jackson-NSANZIMANA/e-recruitment-ui/pull/27) [#28](https://github.com/Jackson-NSANZIMANA/e-recruitment-ui/pull/28) [#29](https://github.com/Jackson-NSANZIMANA/e-recruitment-ui/pull/29) | mains protected (required checks, strict, admins included); evidence bundle on every run; SECRET-ROTATION closed (§5) |
| S01 Officer lifecycle | done | BE [#39](https://github.com/Jackson-NSANZIMANA/e-recruitment/pull/39) | ADR-036, rls/0033; 8 edge operations |
| S02 Frontend foundations | done | FE [#33](https://github.com/Jackson-NSANZIMANA/e-recruitment-ui/pull/33) | ADR-FE-007…013; field-station app, readiness ladder, contract drift v2. Leftover: stale applicant `home.tsx` header comment |
| S03 Release engineering | done | BE [#38](https://github.com/Jackson-NSANZIMANA/e-recruitment/pull/38) · FE [#32](https://github.com/Jackson-NSANZIMANA/e-recruitment-ui/pull/32) [#34](https://github.com/Jackson-NSANZIMANA/e-recruitment-ui/pull/34) | ADR-038 / ADR-FE-014; `Unit tests (every package)` required; `v0.1.0-rc1` tagged |
| B1 Biometric evidence | done | BE [#40](https://github.com/Jackson-NSANZIMANA/e-recruitment/pull/40) | ADR-037, rls/0034; 4 edge operations; SHADOW for the pilot; **DPO sign-off on the DPIA rows pending** |
| S04 Read models | done | BE [#41](https://github.com/Jackson-NSANZIMANA/e-recruitment/pull/41) | ADR-039, rls/0035; 6 edge operations + permission metadata |
| S05 Campaign Studio | in review (M1) | FE [#44](https://github.com/Jackson-NSANZIMANA/e-recruitment-ui/pull/44) | ADR-FE-015; `/campaigns` Studio at E2E-PROVEN; live on the sandbox: policy hash parity with `pnpm rehearse --sandbox rdf-2026` (946bea5e…aa4d8); backend request: policy document in `getCampaignAdminDetail` for a server-side diff |
| S06 Officer workspace + staff admin | done | BE [#45](https://github.com/Jackson-NSANZIMANA/e-recruitment/pull/45) · FE [#35](https://github.com/Jackson-NSANZIMANA/e-recruitment-ui/pull/35) [#36](https://github.com/Jackson-NSANZIMANA/e-recruitment-ui/pull/36) [#37](https://github.com/Jackson-NSANZIMANA/e-recruitment-ui/pull/37) | four-eyes activation-code release (ADR-036 Addendum A); staff admin, queues, application search, DPO queue; zod 4 migration closed CVE-2023-54404 (FE #37) |
| S07 Deployment + staging | ready (M3) | | provider-neutral staging first; production hosting decision gates production only (ROADMAP §4) |
| S08 Field Station | screens done, draft PR (M2; wave B) | FE [#40](https://github.com/Jackson-NSANZIMANA/e-recruitment-ui/pull/40) (part 1) · FE [#46](https://github.com/Jackson-NSANZIMANA/e-recruitment-ui/pull/46) (part 2: setup/enrol, physical signed+acknowledged, medical board, supervisor, conflicts, check-in notice; live-proven on the sandbox: enrol, gate, physical, offline drop, medical, console) | CI green and owner merge pending. Deferred: paper-documents station, offline-signature rung UI, manual-identity list (B2), real Tab A7 perf/camera tests. Backend asks: officer subject in the edge session; 400 not 500 for a non-UUID `capturingOfficerId`. Pilot: **RDF, Nyagatare, Galaxy Tab A7–A10** |
| S09 Fleet + venue ops | done | BE [#44](https://github.com/Jackson-NSANZIMANA/e-recruitment/pull/44) | rls/0036; `field.device.manage`; 4 edge operations; ADR-036 addendum; enrolment still with the screening officer |
| S10a Citizen timeline | ready (M3) | | |
| S10b Citizen screens | waiting on S10a (M3) | | |
| S11a Observability | ready (M3; any free lane) | | `/version` on every service and SPA (ADR-038) |
| S11b Backup + restore | waiting on S07 (M3) | | |
| S14 Operator relocation | ready (M2) | | kit written 2026-10-21; owner: relocation authority and fairness rules |
| P1 Pilot continuity kit | ready (M2; after S06 + S09) | | kit written 2026-10-21; owner: paper procedure, assisted-desk operation; DPO: NID on paper |
| S12a G2G sandbox: platform, NIDA, NESA | in review (M3) | BE [#49](https://github.com/Jackson-NSANZIMANA/e-recruitment/pull/49) | ADR-047 Accepted; ADR-048 §2.1–2.2 Accepted; rls/0042; six announcement scenarios; 14 sandbox personas proven end to end (rdf-2026 4/4, rnp-basic 6/6, rcs-officer-4y 3/3, rcs-junior 1/1) |
| S12b Irembo clearance + SMS | in review (M3) | BE [#52](https://github.com/Jackson-NSANZIMANA/e-recruitment/pull/52) (draft) | ADR-048 Accepted; rls/0040; `attachMyClearanceCertificate`; irembo-certificates + Twilio emulators; `TwilioSmsChannel`; `clearance-matrix` rehearsal; confirmed by the owner 2026-10-28: 90 days, placeholder APPLICATION_CODE allowlist, human content review, sandbox SMS cap 50/day, and the live `SANDBOX_SMS=twilio` test; still open: the real Irembo APPLICATION_CODE values (RIB/Irembo); stacked on S12a #49 |
| S12c Full-stack sandbox (six real campaigns, three apps, one command) | waiting on S12a, S12b | | kit written 2026-10-25; owner: RCS walk-in on exam day |
| B2 Biometric capture | waiting on S08 (M5) | | owner: model licence |
| B3 Biometric evaluation | waiting on B2 (M5) | | owner: evaluation dataset |
