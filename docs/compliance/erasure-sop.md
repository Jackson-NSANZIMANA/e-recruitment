# Standard Operating Procedure — Right-to-Erasure Requests

> **STATUS: DRAFT — operational procedure proposed by engineering. NOT in
> force until the owner and agency data-protection officers sign it. The
> technical steps are verified against the live system; the process
> obligations (deadlines, notification wording) need legal confirmation.**

Prepared: 2026-07-26. Companion to ADR-015. Legal frame: Rwanda Law
N° 058/2021, right to erasure.

## When a citizen demands erasure

### 1. Receive & verify the requester

- Erasure is executed **on the citizen's own demand** (or their lawful
  representative). Verify the requester's identity in person or via an
  approved channel **before** anything else — never execute erasure on an
  unverified request.
- **Self-service intake (ADR-020, owner D10):** a citizen authenticated at
  the portal (OTP session, ADR-018) may file the demand themselves —
  `POST /v1/applicants/me/erasure-request`. The demand lands in the DPO
  queue (`GET /v1/identities/erasure-requests`), timestamped and audited;
  the portal session IS the identity verification for the *demand*. The
  officer reviewing the queue proceeds from step 3 (the applicant UUID is
  on the queue entry), and either executes or **declines with a recorded
  ground** (`POST /v1/identities/erasure-requests/decline`) — the citizen
  sees the decision and its ground in their portal view, and may re-file.
- Walk-in demands continue below; both roads converge on the same
  execution and the same gate.
- Record the request date (self-service: recorded automatically).
  **[LEGAL: statutory response deadline — TBD; surface it on the queue]**

### 2. Resolve the applicant record

- Look up the citizen via the standard verify road (officer walk-in lookup,
  ADR-012) to obtain the opaque **applicant UUID**.
- Never transcribe the raw NID into tickets, email, or chat. The erasure API
  does not accept NIDs — only the UUID.

### 3. Execute

`POST /v1/identities/erasure` with an **officer token** (the executing
officer is personally accountable; system tokens are rejected):

```json
{ "applicantId": "<uuid>" }
```

### 4. Act on the outcome

| Response | Meaning | Officer action |
|---|---|---|
| `200 ERASED` | PII destroyed, sessions deleted, tombstone frozen | Confirm to the citizen in writing. **[LEGAL: notification template TBD]** |
| `200 ALREADY_ERASED` | A prior request already erased this record | Confirm as above |
| `409 REFUSED_ACTIVE_APPLICATION` (names agency + status) | The citizen has an application still in progress | Inform the citizen: erasure is available once the application concludes; they may **withdraw it themselves in the portal** (ADR-020 voluntary withdrawal) and then the gate opens |
| `409 REFUSED_ACCEPT_LOCKED` (names agency) | The citizen is enlisted — retention obligation | Inform the citizen of the legal ground; escalate to the holding agency's DPO if contested |
| `404 NOT_FOUND` | No record exists for that UUID | Confirm to the citizen that no data is held |

Refusals are **truthful and audited** — do not attempt workarounds, and do
not re-try refused requests hoping for a different answer; state changes
(application concluding) are what change the answer.

### 5. What the citizen should be told about scope

- **Destroyed:** name, date of birth, home district/province, NIDA linkage,
  phone hash AND the stored contact phone (ADR-021), biometric linkage, all
  session records. The record cannot be reconstructed — the platform
  enforces this at the database engine.
- **Retained (legal obligation, pseudonymous):** the fact that applications
  existed and their statuses/scores, and the audit trail — none of which can
  identify the citizen after erasure.
- Erasure is **not a ban**: the citizen may verify and apply again in a
  future campaign; a fresh record is created.

## Guardrails (engine-enforced — listed so operators don't fight them)

- An erased record is **frozen**: no role, including system service, can
  un-erase or modify it. There is no "undo" — verify the requester first.
- Every attempt (executed AND refused) lands in the immutable audit log with
  the executing officer's identity. Erasure activity is reviewable.

## Escalations

- Contested refusal → holding agency DPO → **[TBD: supervisory authority process]**
- Suspected wrongful erasure (e.g. impersonated requester) → security
  incident process; the audit trail identifies the executing officer and
  timestamp. The data itself is unrecoverable — this is a personnel/process
  matter, not a technical restore.

## Sign-off block

| Role | Name | Decision | Date |
|---|---|---|---|
| Platform owner | — | PENDING | — |
| Agency DPOs (RDF/RNP/RCS) | — | PENDING | — |
