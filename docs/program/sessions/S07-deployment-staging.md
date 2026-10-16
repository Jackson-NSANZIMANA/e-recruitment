# S07 — Deployment topology and staging

**Phase 2 · infrastructure lane · depends on S03 (signed images)** · Branch `feat/s07-deploy` · Reserved: **ADR-040**

## Why
There is no deployment definition at all: no manifests, no secrets management, no TLS, no environments. Staging is where S11's observability and backups, S17's load tests and the pilot rehearsals run, so it must exist before Phase 3 ends.

## Decide first (ADR-040; the owner decision is required for hosting)
| Question | Recommendation |
|---|---|
| Runtime | Kubernetes with Helm, if the hosting provider runs it. Otherwise Docker Compose on hardened VMs for the pilot, with the same images and a migration path. Do not build both. |
| Hosting | a Rwandan data centre; two sites for production (baseline §15.6). Staging may be single-site. |
| Data services | PostgreSQL 16 (managed or operator) with PITR; Kafka (KRaft, 3 brokers in production, 1 in staging) with **retention pinned** (ADR-019 flag); MinIO (versioning on); ClamAV |
| Secrets | KMS/HSM or Vault; **fresh production secrets**, never derived from dev values (S00 rotation closure); the QR signing key separated from the token key (already enforced) |
| Ingress | one public origin per app; `/edge/v1/**` routed only to edge-gateway; TLS everywhere; internal mTLS or network policies between services; **no service port reachable from outside** |

## Delivers
- Helm chart(s) or compose bundle for 12 services, 3 SPAs and the data tier. Every configuration value comes from the production-guard canon (`shared-config`); the production guard must pass at boot.
- Network policies: only the edge is public, services talk only to their declared peers, and the database is reachable only by services.
- Migration and bootstrap job: `bootstrap-db.sh` as an idempotent pre-deploy job **without dev seeds** (`NODE_ENV=production` skips them); the first admin via the provisioner CLI with a real `FIRST_ADMIN_DATABASE_URL` (this un-skips the last proof).
- **Staging environment**, deployed by a pipeline from S03 image digests, with:
  - G2G mocks allowed **in staging only**, behind an explicit `STAGING_MOCKS=1` that the production guard refuses;
  - `LogSmsChannel` → staging still needs an SMS path: the dev inbox is refused under `NODE_ENV=production`, so staging runs `NODE_ENV=staging`, a distinct mode the guard treats as non-production but *not dev*. Decide it in ADR-040.
- The rehearsal fence gains an explicit staging allow-list (host names in configuration, never "any host").
- A data-flow and residency map: every store, replica, backup, log sink and support path, with its location. Input to the DPO (G4).

## Read first
`packages/shared-config/src/production-guard.ts` (the deployment contract), `.env.example`, `scripts/bootstrap-db.sh`, `docs/compliance/retention-schedule.md`, `SECRET-ROTATION.md`, the S03 hand-off, baseline §15.6–15.9.

## Owns
- `infrastructure/deploy/**` (new)
- `.github/workflows/deploy-*.yml`
- the rehearsal fence's staging allow-list (append-only)
- ADR-040
- the data-flow map document

## Exit gate
- [ ] Staging deployed by pipeline from signed images; every service passes the guard and `/ready`.
- [ ] `pnpm rehearse` (staging-allowed) and the live spec pass **against staging**.
- [ ] No service except the edge is reachable from outside (scan evidence).
- [ ] The provisioner-auth proof runs green against staging (the last skipped proof).
- [ ] ADR-040 merged; data-flow map delivered to the DPO; status board updated.

## Owner decisions (blocking)
- Hosting provider and site(s)
- KMS/HSM custody
- Domain names
- Staging data policy (synthetic only: **yes**)

## Session starter
```text
You are the platform and infrastructure engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Repos: ~/Documents/projects/e-recruitment-software/e-recruitment and .../e-recruitment-ui.

This is session S07 — Deployment topology and staging. Read your kit e-recruitment/docs/program/sessions/S07-deployment-staging.md, docs/program/README.md and quality-workflow.md, shared-config's production-guard.ts and the S03 hand-off; follow them.

First ask me the blocking owner decisions (hosting, KMS custody, domains). Then: ADR-040, deployment definitions for 12 services + 3 SPAs + data tier from signed image digests, network policies with only the edge public, an idempotent bootstrap job without dev seeds, fresh secrets from KMS, and a staging environment where the rehearsal journey passes and the provisioner-auth proof finally runs.

Use ADR-040 only. /security-review is mandatory. Done = staging live by pipeline, evidence attached, data-flow map delivered, status board updated, hand-off note.
```
