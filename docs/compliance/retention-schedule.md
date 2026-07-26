# Data Retention Schedule — USRP

> **STATUS: DRAFT — pending agency/DPO sign-off.** The periods below were
> **adopted operationally by the platform owner (decision D7, 2026-07-26,
> ADR-019)** and are what the retention sweep enforces today; they remain
> subject to revision by the agencies' legal officers at sign-off. The
> mechanism column is real (verified against the codebase).

Prepared: 2026-07-26. Updated 2026-07-26 (D7 adoption + sweep built, ADR-019).
Companion to ADR-015, ADR-019 and `dpia.md`.

## Principles

1. **PII and processing record have different clocks.** PII
   (`applicant_identities`) is retained only while a purpose exists;
   the pseudonymous processing record (applications, history, audit) is
   retained under the agencies' legal-obligation basis.
2. **Erasure ends the PII clock early** when a citizen lawfully demands it
   (ADR-015 gate).
3. **Enlistment converts the record**: an accept-locked citizen's identity
   row becomes part of a service record — recruitment retention rules stop
   applying and personnel-record rules (out of USRP scope) take over.

## Schedule

| Data class | Where | Retention period | End-of-life mechanism | Status |
|---|---|---|---|---|
| Identity PII of a citizen who never applied | `applicant_identities` (no application rows) | **12 months after registration (owner D7)** | Retention sweep (ADR-019, `retention-sweep.ts`) → same gated tombstone as erasure | **Built + proven (gate #33)**; dry-run default, `--execute` performs |
| Identity PII, all applications negative-terminal | `applicant_identities` | **24 months after the last application activity (owner D7)** — appeal window | Retention sweep → tombstone; or citizen-demanded erasure at any time (gate allows) | **Built + proven (gate #33)** |
| Identity PII of enlisted citizen | `applicant_identities` (accept-locked) | Out of USRP scope — personnel record | Erasure REFUSED (`ACCEPT_LOCKED`); discharge-linked erasure is a flagged follow-on | Enforced today |
| Sessions (token, IP, UA) + OTP challenges | `applicant_sessions`, `applicant_otp_challenges` | **expiry/termination + 30 days (owner D7)** | Hard DELETE on erasure (built) + sweep purge (ADR-019) | **Built + proven (gate #33)** |
| Applications + status history | ops schemas | **7 years (owner D7)** — public-recruitment record | None (engine-immutable); PII-free after subject's tombstone | Enforced; no destruction mechanism by design within USRP |
| Audit log | `audit_log.audit_entries` | **10 years (owner D7)** | None (engine-immutable, PII-free) | Enforced; as above |
| Physical test scores | ops schemas | Same as applications | Same | Enforced |
| Uploaded documents | MinIO (no upload path exists yet) | **TBD — must be decided BEFORE the upload slice ships** | MUST be wired into erasure when built (ADR-015 follow-on #2) | Not built — blocking note |
| Kafka event payloads | brokers | **≤ 30 days (owner D7)** | Broker retention config | Config not yet pinned in infra — flagged in ADR-019 |
| DB backups | — | **NONE EXIST.** Backups are BLOCKED on the per-citizen DEK upgrade (ADR-015 D1) | Crypto-shred (future) | Ordering constraint |
| WAL | PG cluster | Rotates with cluster config | Accepted residual for erasure (ADR-015) | Accepted risk |

## Operating the sweep (ADR-019)

- `pnpm --filter @usrp/identity-service retention:report` — dry-run, prints
  what the policy would sweep; changes nothing.
- `pnpm --filter @usrp/identity-service retention:execute` — performs the
  sweep. Tombstones go through the SAME gated erasure path as citizen
  demands (active/enlisted citizens are structurally unsweepable); every
  tombstone emits a `RETENTION_ERASURE_EXECUTED` audit.
- Periods live in ONE place in code (`identity-service/src/config.ts`,
  `RETENTION_*`) and must be changed together with this document.

## Sign-off block

| Role | Name | Decision | Date |
|---|---|---|---|
| Platform owner | Jackson NSANZIMANA | **Periods adopted operationally (D7)** — final sign-off pending agency review | 2026-07-26 |
| RDF legal/records | — | PENDING | — |
| RNP legal/records | — | PENDING | — |
| RCS legal/records | — | PENDING | — |
