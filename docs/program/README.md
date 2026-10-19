# USRP sessions — how to run the programme

The plan is in [`delivery-programme.md`](delivery-programme.md). The rules for every session are in [`quality-workflow.md`](quality-workflow.md). Each session has a self-contained kit in [`sessions/`](sessions/) that ends with a **Session starter**: paste it into a new Claude Code session opened at `~/Documents/projects/e-recruitment-software`.

## Order

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
| S01 Officer lifecycle | in review | BE (this PR) | ADR-036, rls/0033; 8 edge operations; unblocks S06 and B1 once merged |
| S02 Frontend foundations | ready | | also: stale applicant `home.tsx` header comment (W0-03 leftover) |
| S03 Release engineering | ready | | also: make the backend unit suites a required check (run today only by the evidence job) |
| B1 Biometric evidence | waiting on S01 | | |
| S04 Read models | waiting on S01 | | |
| S05 Campaign Studio | waiting on S02 (+S04 list) | | |
| S06 Officer workspace + staff admin | waiting on S01, S02 | | |
| S07 Deployment + staging | waiting on S03 | | owner: hosting decision |
| S08 Field Station | waiting on S02 | | owner: pilot agency, device model |
| S09 Fleet + venue ops | waiting on S04 | | |
| S10a Citizen timeline | waiting on S04 | | |
| S10b Citizen screens | waiting on S10a, S02 | | |
| S11a Observability | waiting on S03 | | |
| S11b Backup + restore | waiting on S07 | | |
| B2 Biometric capture | waiting on S08, B1 | | owner: model licence |
| B3 Biometric evaluation | waiting on B2 | | owner: evaluation dataset |
