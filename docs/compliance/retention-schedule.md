# Data Retention Schedule — USRP

> **STATUS: DRAFT — every retention period below is a PLACEHOLDER (TBD)
> until signed by the owner and the agencies' legal officers. The mechanism
> column is real (verified against the codebase); the periods are not.**

Prepared: 2026-07-26. Companion to ADR-015 and `dpia.md`.

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
| Identity PII of a citizen who never applied | `applicant_identities` (no application rows) | **TBD — proposal: 12 months after last activity** | Retention sweep (follow-on) → same tombstone as erasure | Mechanism: erasure code exists; sweep not built |
| Identity PII, all applications negative-terminal | `applicant_identities` | **TBD — proposal: 24 months after final terminal status** (appeal window) | Retention sweep → tombstone; or citizen-demanded erasure at any time (gate allows) | As above |
| Identity PII of enlisted citizen | `applicant_identities` (accept-locked) | Out of USRP scope — personnel record | Erasure REFUSED (`ACCEPT_LOCKED`); discharge-linked erasure is a flagged follow-on | Enforced today |
| Sessions (token, IP, UA) | `applicant_sessions` | **TBD — proposal: expiry + 30 days** | Hard DELETE on erasure (built); scheduled purge (follow-on) | Partially built |
| Applications + status history | ops schemas | **TBD — proposal: 7 years** (public-recruitment record) | None (engine-immutable); PII-free after subject's tombstone | Enforced |
| Audit log | `audit_log.audit_entries` | **TBD — proposal: 10 years** | None (engine-immutable, PII-free) | Enforced |
| Physical test scores | ops schemas | Same as applications | Same | Enforced |
| Uploaded documents | MinIO (no upload path exists yet) | **TBD — must be decided BEFORE the upload slice ships** | MUST be wired into erasure when built (ADR-015 follow-on #2) | Not built — blocking note |
| Kafka event payloads | brokers | **TBD — proposal: topic retention ≤ 30 days** | Broker retention config | Config not pinned |
| DB backups | — | **NONE EXIST.** Backups are BLOCKED on the per-citizen DEK upgrade (ADR-015 D1) | Crypto-shred (future) | Ordering constraint |
| WAL | PG cluster | Rotates with cluster config | Accepted residual for erasure (ADR-015) | Accepted risk |

## Sign-off block

| Role | Name | Decision | Date |
|---|---|---|---|
| Platform owner | — | PENDING | — |
| RDF legal/records | — | PENDING | — |
| RNP legal/records | — | PENDING | — |
| RCS legal/records | — | PENDING | — |
