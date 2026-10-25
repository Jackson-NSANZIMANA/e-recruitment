# S12c — Full-stack production sandbox: six real campaigns, three apps, one command (backend + frontend)

**M3 · backend then frontend · depends on S12a (simulators, population, binding) and S12b (clearance, SMS); uses S06's workspace and queues** · Branches `feat/s12c-policy-v2` (BE), `feat/s12c-sandbox-ui` (FE), `feat/s12c-sandbox-up` (BE orchestration) · Reserved: **ADR-049** (campaign policy v2), **`rls/0041_campaign_policy_v2.sql`**, **ADR-FE-019** (sandbox presentation and NIDA pre-fill)

## Why
S12a and S12b make the registries production-shaped. This session makes the **whole recruitment life cycle** run end to end in a production-grade sandbox:

- the six real campaigns (docs/product/recruitment-announcements-2025-2026.md);
- the citizen applying in the portal;
- officers working in the console;
- the gate and stations in field-station;
- the decision and acceptance;

all on simulated registries that behave like the live ones, started with one command.

## Delivers

### A. Campaign policy v2 (backend; ADR-049, rls/0041)
The real announcements need rules the policy model can't express yet. S12a's hand-off lists the gaps; expect at least:

- **age caps per qualification within one category**: RDF Reserve 18–25 for A-Level, ≤26 for A0/IPRC, ≤27 for Medicine, Engineering and Law; RCS officer specialist ≤27;
- **education alternatives** (A0 *or* A1 IPRC), and **minimums below A2** (S3);
- **the conviction rule as policy**: never convicted; never sentenced to ≥6 months; never sentenced to >6 months; *and* not under prosecution. ADR-048's clearance check evaluates content against it.
- **the documents list per campaign**: sector good-conduct certificate, single-status certificate, birth certificate, notarisation, government-doctor certificate. Each declares its satisfaction mode (registry-verified, upload, or present at venue), per ADR-032.
- **multi-district venues and split dates** (RCS officer regional venues; RDF two-day districts);
- **walk-in per campaign**: RDF 2026 and RCS officer 2026 both announce exam-day registration. *Default: enabled only where the campaign says so; RCS walk-in needs an owner/agency decision* (ADR-012 assumed RDF only).

Policy versions stay immutable and hash-bound (ADR-030). The rehearsal scenarios from S12a are re-expressed in v2, and **the publication preflight passes them as written in the originals**.

### B. NIDA pre-fill and citizen experience (backend read + frontend; ADR-FE-019)
- A citizen-safe edge read of *my verified identity* (session-scoped, field-allowlisted) covering the form identity block that NIDA holds (announcements doc §6).
  - It never returns photo, signature, parents' names or the full NID to the browser unless a field is shown to the citizen and allowlisted in the ADR. The DPIA row is updated.
- **Apply wizard:**
  - identity is shown read-only, "as recorded by NIDA";
  - only what NIDA lacks is asked for: residence if different, phone, email, education history, employment, the dismissal and security-service declarations, references, the declaration of accuracy;
  - **health questions are not asked in the portal**; they belong to the medical station (DPIA).
- **Category picker:** shows the per-qualification caps and the alternatives in plain language (rw/en/fr), with an eligibility explanation per qualification.
- **Clearance number field and checklist states** (S12b hand-off); citizen-safe "this record does not match your identity" copy with a correction path; NESA `PENDING` (results not yet published) copy.
- **A persistent SANDBOX banner** in all three apps, plus rehearsal markers on passes and prints (ADR-035 pattern).

### C. `pnpm sandbox:up` (backend orchestration)
- One command builds or pulls the S03 images and starts, under its own compose project (`usrp-sandbox`, ports 51xx, its own volumes):
  - Postgres, Kafka, MinIO and ClamAV;
  - all services under `USRP_ENVIRONMENT=sandbox` + `NODE_ENV=production`;
  - the three SPA serving images (ADR-FE-014);
  - the `g2g-sandbox` simulators;
  - a local TLS edge (Caddy internal CA), so cookies, CSP and `secureCookies` behave as in production.
- **Seeding:**
  - the six campaigns via `pnpm rehearse` (policy v2);
  - staff per agency, provisioned through S01's lifecycle (admin, a second admin for the four-eyes release, gate, medical, decision authority, DPO, field supervisor);
  - enrolled field-station devices;
  - the synthetic population.

  With `SANDBOX_PRIVATE_PERSONA_DIR` set, the owner's own persona joins, locally.
- `pnpm sandbox:down` keeps data; `pnpm sandbox:reset` drops the sandbox volumes **only** (never the dev stack's).
- A **sandbox guide** (`docs/sandbox/README.md`): URLs, staff handles, persona catalogue, behaviour switches (registry outage, 429, venue down), and how to read the SMS inbox or receive real SMS (S12b).

### D. Live journeys (Playwright, opt-in `USRP_SANDBOX=1`)
Across all three apps, on `sandbox:up`, with synthetic personas:

1. RNP Basic 2025: eligible persona → sign-in (SMS) → pre-filled apply → NIDA, NESA bound and clearance verified → slot → exam pass → gate admission → physical → medical → decision → acceptance; the citizen sees the outcome.
2. RDF Reserve 2026: A0 persona aged 26 accepted, aged 27 refused with the cap named; Medicine graduate aged 27 accepted.
3. RCS officer 4-year track: science ≥70% accepted, 69% refused with the reason.
4. Failures:
   - NESA name partial → amber → officer clears;
   - clearance of the wrong type → correctable;
   - clearance content review → officer decides;
   - NIDA 503 during submission → `PENDING`, then recovered;
   - registry 429 → never a negative verdict.
5. RDF walk-in on exam day.
6. Cross-agency acceptance lock and auto-withdrawal.
7. Erasure request → DPO decision.

## Owns
- campaign-policy domain and rls/0041 (BE)
- the identity read operation and edge projection
- `infrastructure/sandbox/**` and `pnpm sandbox:*`
- apply wizard, category picker and checklist changes (FE)
- the sandbox banner (FE)
- `e2e/sandbox/**`
- ADR-049, ADR-FE-019
- `docs/sandbox/**`
- shared files, append-only

## Quality bar
- **All six campaigns publish from policy v2 with no manual fix-up,** and their venue and date tables equal the announcements doc.
- **Every live journey passes on `sandbox:up` from a clean reset, twice in a row** (idempotent seeding).
- **No personal data in any tracked file:** S12a's personal-data rule stays green.
- The **private persona run is local only**; report pass or fail, never values.
- `/security-review` is mandatory (a new identity read, health-data boundary, TLS and cookies).
- **Accessibility:** the pre-fill and picker pass axe; locale parity for rw, en and fr.

## Exit gate
- [ ] Policy v2 merged; the six campaigns publish; the walk-in decision is recorded.
- [ ] Identity read and pre-fill merged; DPIA row updated.
- [ ] `pnpm sandbox:up` starts the full stack from clean; the guide is published.
- [ ] All live journeys pass twice from a reset; CI runs the synthetic subset (`sandbox:up` in a CI job if it fits the runner, otherwise documented as local-only with the reason).
- [ ] Capability map, status board and ROADMAP ledger updated.

## Owner decisions (defaults if not answered)
- **RCS walk-in on exam day:** default *off* until the agency confirms (the announcement says yes).
- **Identity fields shown to the citizen:** default names, sex, DOB, place of birth, nationality and district of residence; never photo, signature or parents' names.
- **Health questions:** default *never in the portal* (medical station only).

## Session starter
```text
You are a principal full-stack engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Backend: ~/Documents/projects/e-recruitment-software/e-recruitment; frontend: ../e-recruitment-ui.

This is session S12c — Full-stack production sandbox. Read your kit e-recruitment/docs/program/sessions/S12c-full-stack-sandbox.md, then ADR-047, ADR-048, docs/product/recruitment-announcements-2025-2026.md, the S12a and S12b hand-offs, docs/program/ROADMAP.md §8.4, README.md and quality-workflow.md, and follow them.

Goal: campaign policy v2 that expresses the six real campaigns exactly (per-qualification age caps, education alternatives, conviction rules as policy, per-campaign documents, multi-district venues, walk-in per campaign); a citizen-safe NIDA identity read with apply-wizard pre-fill; a SANDBOX banner across the three apps; pnpm sandbox:up starting the full production-mode stack with TLS, seeded campaigns, staff, devices and the synthetic population; and live Playwright journeys across all three apps covering success, every failure profile, walk-in, the cross-agency lock and erasure.

PRIVACY (mandatory): no personal value from sandbox-demo in any tracked file; the private persona is local only, so report pass/fail without values. Ask me the RCS walk-in decision first; use the kit defaults if I don't answer. Use ADR-049, rls/0041 and ADR-FE-019 only. /security-review is mandatory. Work in your own worktrees under ~/Documents/projects/e-recruitment-software/worktrees/; the sandbox uses its own compose project and ports 51xx; never touch the dev stack or kill TTY processes. Done = CI green on every PR head, the journeys passing twice from reset, the guide published, the status board and ledger updated.
```
