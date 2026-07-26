# G2G Integration — Authorization Prerequisites

> **STATUS: DRAFT — a checklist of what must be true before ANY real
> government system is connected. This document grants nothing; it exists
> so nobody mistakes a working mock for an authorized integration.**

Prepared: 2026-07-26.

## Standing boundary (platform charter)

All four G2G integrations in this repository run against **local mocks**
(`usrp-nida-mock`, `usrp-nesa-mock`, `usrp-rib-mock`, `usrp-hec-mock`)
seeded with synthetic citizens. **No code in this repository has ever
connected to a real government system, and none may** until the
prerequisites below are met per integration. Connecting to real NIDA, NESA,
RIB, or HEC endpoints — even "read-only", even "just to test" — without the
listed authorizations is prohibited.

## Per-integration prerequisites

Applies to each of NIDA (identity), NESA (academic), RIB (criminal
clearance), HEC (higher-education) independently:

1. **Legal instrument** — a signed data-sharing agreement / MoU between the
   requesting agency (RDF/RNP/RCS) and the data-holding institution, citing
   the legal basis under Law N° 058/2021 and the agency's recruitment
   mandate. Held by: **[OWNER/agency legal — none exists yet]**.
2. **Scope definition** — the exact fields, query patterns, and volumes
   authorized (e.g. NIDA: lookup by NID → identity attributes; RIB:
   clearance status only, never case detail). The platform's mock contracts
   (`packages/shared-types`, mock services) are the *engineering proposal*
   of that scope — the institutions must confirm or amend it.
3. **Credentials & transport** — production credentials issued by the
   institution (HMAC secrets / mTLS certs), delivered out-of-band, stored in
   the deployment secret store — never in this repository. Government
   network / VPN requirements per institution.
4. **Supervisory clearance** — whatever NCSA / supervisory-authority
   approval the institutions require for automated citizen-data exchange.
5. **DPIA update** — `dpia.md` §3 row 8 revised from "mocks only" to the
   real risk profile of each live connection, and re-signed.

## Engineering facts relevant to the authorization discussions

- **NIDA:** the platform stores no raw NID and no NIDA response payloads
  beyond encrypted identity attributes; the G2G subject hash
  (`encrypted_nida_lookup_hash`) is stored encrypted and destroyed on
  erasure (ADR-015). Two-hash contract keeps the internal identifier
  independent of the NIDA-facing one.
- **NESA / HEC:** only verification request ids, timestamps, and
  eligibility verdicts are stored — no certificates, no transcripts.
- **RIB:** only clearance status codes are stored — no case narratives.
- All G2G calls are HMAC-authenticated in the mock contract; timeouts and
  failure modes are fail-closed (an unreachable registry never passes a
  gate).

## Who may flip the switch

Changing a `*_BASE_URL` from a mock to a real endpoint is an **accountable
deployment act of the owner**, gated on a completed checklist above for that
integration — never an engineering default, never a dev convenience.

| Integration | Legal instrument | Scope confirmed | Credentials | Clearance | Authorized? |
|---|---|---|---|---|---|
| NIDA | ✗ | ✗ | ✗ | ✗ | **NO — mock only** |
| NESA | ✗ | ✗ | ✗ | ✗ | **NO — mock only** |
| RIB | ✗ | ✗ | ✗ | ✗ | **NO — mock only** |
| HEC | ✗ | ✗ | ✗ | ✗ | **NO — mock only** |
