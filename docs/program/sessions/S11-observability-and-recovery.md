# S11a — Observability → S11b — Backup and restore

## S11a — Observability
**Phase 3 · infrastructure plus shared packages · depends on S03 (`/version`)** · Branch `feat/s11a-observability` · Reserved: **ADR-042**

### Why
Today there are structured logs and `/health`/`/ready`, and nothing else: no metrics, traces or alerts. During a registration window nobody would know that NIDA latency had tripled, that the outbox was growing, or that one venue's tablets had stopped syncing.

### Decide first (ADR-042)
The repository's ethos is a **minimal supply-chain surface** (zero-dependency `shared-http`, `shared-config`, `shared-security`). Two options:

| Option | What it means |
|---|---|
| A — recommended | **Zero-dependency instrumentation**: a Prometheus text `/metrics` in `shared-http`, W3C `traceparent` propagation (the correlation ID already flows end to end), structured spans as log events. An **OpenTelemetry Collector** in the infrastructure scrapes, receives and exports. |
| B | The OpenTelemetry Node SDK in every service. More automatic, much larger dependency tree. |

Record the choice.

### Delivers
- **Metrics:**
  - RED per route (rate, errors, duration) in shared-http;
  - Kafka consumer lag and dead-letter count (shared-events);
  - outbox depth and age (shared-database);
  - G2G call latency and error rate per registry (NIDA, NESA, HEC, RIB adapters);
  - OTP request rate;
  - slot fill per session;
  - field acknowledgement latency;
  - biometric evidence outcomes **by mode** (B1).

  Every label is free of PII (lint test).
- **Traces:** `traceparent` in and out of every HTTP call and Kafka envelope; spans for the submission → gates → slot chain.
- **Infrastructure:** a dev `docker-compose.tier3.observability.yml` (Collector, Prometheus, Grafana, Tempo, Loki, Alertmanager) and the same in S07's staging chart.
- **Dashboards as code** (Grafana JSON): platform health, registration funnel (counts only), G2G health, event backbone, exam-day venue, version skew.
- **Alerts as code** with runbook links: edge 5xx > SLO, a G2G registry degraded, outbox age > N minutes, a dead letter appears, consumer lag growing, a venue with no sync for 15 minutes on exam day, version skew detected.
- **SLO definitions:** baseline §15.8 proposals, marked *proposed* until ratified.

### Exit gate
- [ ] A rehearsal run produces visible traces for persona A's whole chain and populated dashboards.
- [ ] A deliberately stopped NIDA mock fires the "registry degraded" alert within its window (documented drill).
- [ ] A PII lint over metric labels and log fields is green.
- [ ] CI green on the PR head; ADR-042 merged; status board updated.

### Session starter
```text
You are the platform reliability engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Repos: ~/Documents/projects/e-recruitment-software/e-recruitment (main) and .../e-recruitment-ui.

This is session S11a — Observability. Read your kit e-recruitment/docs/program/sessions/S11-observability-and-recovery.md (part S11a), docs/program/README.md and quality-workflow.md, the handbook's supply-chain principles and the S03 hand-off; follow them.

Goal: ADR-042 (recommend zero-dependency /metrics + traceparent propagation with an OpenTelemetry Collector), RED/Kafka/outbox/G2G/OTP/slot/field/biometric metrics with PII-free labels, traces across the submission chain, a tier3 observability compose, dashboards and alerts as code with runbook links, and proposed SLOs — proven by a rehearsal trace and a registry-outage alert drill.

Use ADR-042 only. Done = CI green on the PR head, drill evidence, status board updated, hand-off note for S11b.
```

## S11b — Backup and restore
**Phase 3 · infrastructure · depends on S07 (staging)** · Branch `feat/s11b-recovery` · Reserved: **ADR-043**

### Why
"A backup is not proven until a restore is completed and checked" (baseline §15.9). Today there are no backup or restore scripts, and the RPO/RTO targets are proposals only.

### Delivers (ADR-043)
- **PostgreSQL:** continuous WAL archiving plus base backups (pgBackRest or WAL-G; record the choice) to storage in the approved jurisdiction, encrypted with a KMS key. **PITR.**
- **MinIO:** versioning plus replication or backup; sealed documents stay sealed.
- **Kafka:** documented as **reconstructible** (the outbox is the source of truth for staged events) with retention pinned. The replay procedure is proven, not assumed.
- **Restore drill script** (`scripts/restore-drill.sh`):
  1. restore to a fresh instance at a chosen point in time;
  2. re-apply RLS (`bootstrap-db.sh` replay-safe);
  3. compare row counts and checksums of key tables;
  4. run the RLS isolation proof and the audit immutability proof **on the restored database**;
  5. **measure RPO and RTO.**
- **Runbooks:** database primary loss, event backlog/dead letters, wrong policy applied at scale, signing-key compromise, device lost. Owners and first-response steps, per baseline §15.9.

### Exit gate
- [ ] A drill on staging: point-in-time restore, checksums match, isolation and immutability proofs green on the restored data, RPO/RTO measured and recorded.
- [ ] Runbooks merged; ADR-043 merged; status board updated.

### Session starter
```text
You are the platform reliability engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Backend: ~/Documents/projects/e-recruitment-software/e-recruitment.

This is session S11b — Backup and restore. Read your kit e-recruitment/docs/program/sessions/S11-observability-and-recovery.md (part S11b), docs/program/README.md and quality-workflow.md, and the S07 hand-off; follow them.

Goal: ADR-043, PostgreSQL WAL archiving + base backups + PITR encrypted with KMS in the approved jurisdiction, MinIO versioning/backup, Kafka declared reconstructible from the outbox with a proven replay procedure, a restore-drill script that compares checksums and re-runs the RLS-isolation and audit-immutability proofs on the restored database and measures RPO/RTO, and first-response runbooks.

Use ADR-043 only. Done = a passing drill on staging with measured RPO/RTO, runbooks merged, status board updated, hand-off note.
```
