# ADR-033 — The citizen's downloadable exam QR

**Status:** Accepted (2026-10-15). **Extends:** ADR-009 (signed slot invitation),
ADR-026 (slot ledger). **Supersedes:** ADR-009's "transport-only" delivery.

## Context
ADR-009 made the exam QR an Ed25519-signed, offline-verifiable credential
(`USRP-SLOT.v1.<claims>.<sig>`) and kept it transport-only until a delivery
channel existed. The planned channel, SMS, is not available (known gap). So a
citizen who completed their application had **no way to obtain the QR** they
must present at the physical screening.

The owner asked for: on completing the application, a QR page the citizen can
download and bring to the screening.

## Decision
1. **The QR is the signed slot invitation — nothing weaker.** It names the
   venue and the exam day and is verified offline at the gate with the
   scheduling public key. No second "application QR" is minted.
2. **When it appears.** The slot is assigned automatically the moment the
   three eligibility gates pass (age, academic, criminal). The QR page is
   available from submission onwards and shows the state truthfully:

   | State | Shown |
   |---|---|
   | `PENDING` | still being vetted — "your QR will appear here" (no QR) |
   | `READY` | the QR + venue, date, reporting hour, valid-until; **Download** and **Print** |
   | `ON_HOLD` | late adjudication hold — QR withheld |
   | `WALK_IN` | admitted on site (RDF) — no invitation |
   | `COMPLETED` / `CLOSED` / `EXPIRED` | no QR |
   | `UNAVAILABLE` | assigned before persistence existed — re-announcing the assignment backfills it |

   Handing out an admission QR at bare submission was rejected: it would carry
   no venue or date and would let an applicant who later fails vetting arrive
   at a gate with a credential.
3. **Persistence.** `applications.qr_signed_token` (rls/0031): the exact token
   scheduling signed; write-once by trigger; shape-checked. The slot
   projection writes it; a redelivery of the SAME assignment may fill an empty
   column (backfill) but can never replace an issued token.
4. **Read path.** Edge `GET /edge/v1/me/applications/exam-invitation` →
   identity-service (session subject) → application-service
   `GET /v1/applications/exam-invitation/by-applicant` (system token,
   `applicant_id = subject`). Each tier rebuilds the body from a closed
   allowlist; a payload that is not a `USRP-SLOT.v1` token is a 502, never
   relayed. Every response is `cache-control: no-store`.
5. **Rendering.** The portal renders the QR client-side (`qrcode-generator`,
   MIT, zero dependencies) and offers a PNG download and a print view. The
   token is PII-free by construction (ADR-009 claim whitelist).

## Consequences
- A downloaded QR is a credential until the end of exam day (UTC); a screenshot
  shared with someone else is still bound to this application id and must be
  matched at the gate. Admission is now single-use and bound to the national
  ID card (ADR-034); once used, the page shows ADMITTED and never the QR.
- Key rotation is enabled by `keyId` but not implemented; the private key must
  move to an HSM/KMS before production (ADR-009 residual, unchanged).
- **Scheduling deferrals no longer strand the citizen at PENDING.** A
  clearance scheduling could not place (no venue published for the district,
  venue full or inactive) used to be audited and never retried. Application-
  service now re-announces `APPLICATION_ELIGIBILITY_CLEARED` for rows stuck at
  `DOCUMENT_REVIEW_GREEN` with no slot, at most once per grace period per row
  (`SLOT_RETRY_*`, default 6 h), only for campaigns that can still hold an exam,
  staged in the outbox. Scheduling is idempotent per application (ADR-026), so a
  retry either places the citizen, re-announces the original slot, or records
  another deferral. Proven by `verify-slot-retry.ts`.
- SMS delivery of the QR remains a **known gap**.
