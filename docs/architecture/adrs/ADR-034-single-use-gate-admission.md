# ADR-034 — Single-use admission at the venue gate (BUILD-003)

**Status:** Accepted (2026-10-15). **Extends:** ADR-009 (signed slot invitation),
ADR-033 (the citizen's downloadable exam QR), ADR-031 (permissions and SoD),
ADR-003/010 (field score capture).

## Context
ADR-033 gave every scheduled citizen a QR to bring to the screening: the
Ed25519-signed slot invitation, valid for the whole exam day. Three things were
missing:

1. **Nothing recorded that a QR had been used.** A screenshot forwarded to a
   friend could be presented at a second gate, or the same gate twice.
2. **Nothing bound the QR to the person.** It carries no PII by design
   (ADR-009), so a different person could present it.
3. **The digital lane never reached the physical test.** `PHYSICAL_TEST_COMPLETE`
   requires `PHYSICAL_TEST_SCHEDULED`, which only an SMS-delivery event set — and
   there is no SMS provider (known gap). Every digitally scheduled candidate was
   stranded at `SLOT_ASSIGNED`.

## Decision
1. **Admission spends the QR.** The screening officer scans it and types the
   national ID from the candidate's card. One admission per application, ever:
   `<agency>_ops.gate_admissions` has UNIQUE `application_id` and UNIQUE
   `ticket_id` (rls/0032). Concurrent scans serialise on the application row
   lock; the unique index is the backstop (a violation is retried once and
   answered `ALREADY_ADMITTED`, never a 500).
2. **Who.** New permission `admission.gate`, granted to `screening_officer`
   only — the same front-door post as `document.verify.venue` (owner decision
   2026-10-14). The gate post cannot decide, accept or review medically.
3. **Where the decision lives.** application-service, the state owner, as the
   officer's own agency DB role, in one transaction. The checks run in a fixed
   order that is part of the contract:

   | # | Outcome | HTTP | Meaning |
   |---|---|---|---|
   | 1 | `MALFORMED_TICKET` | 422 | not a `USRP-SLOT.v1` ticket |
   | 2 | `WRONG_AGENCY` | 422 | another agency's exam |
   | 3 | `UNKNOWN_TICKET` | 422 | no such application in this agency |
   | 4 | `TICKET_NOT_ISSUED` | 422 | not byte-identical to the stored token (forged/altered) |
   | 5 | `ALREADY_ADMITTED` | 409 | spent — checked before venue/day, so a copied screenshot is a duplicate at any gate |
   | 6 | `NOT_ADMISSIBLE` | 409 | withdrawn, rejected, on hold, or past the stage |
   | 7 | `WRONG_VENUE` | 409 | this gate is not the ticket's venue (case/space-insensitive) |
   | 8 | `TOO_EARLY` / `EXPIRED` | 409 | today in **Africa/Kigali** is not the exam day |
   | 9 | `IDENTITY_MISMATCH` | 409 | the card's national ID is not this applicant's — asked last |
   | — | `ADMITTED` | 200 | admission written |

4. **Authenticity without a key.** application-service holds no QR public key
   and does not need one: a token byte-identical to the one stored (write-once,
   rls/0031) on the application *is* the token scheduling signed. Offline gates
   can still verify the signature locally (ADR-009); only an online check can
   enforce single use, so the online service is the authority.
5. **Identity binding without moving the secret.** Only identity-service holds
   `NATIONAL_ID_HMAC_KEY`, so it is the gate's front door
   (`POST /v1/gate/admissions`). It hashes the typed number, forgets it, and
   forwards `{ qrToken, gateVenueName, nationalIdHash }` to application-service
   **under the officer's own bearer token** — authorization stays with the human
   at the owning service, not with a service assertion (same rule as the edge).
   The comparison is done in the engine by `<agency>_ops.gate_identity_matches`
   (SECURITY DEFINER, EXECUTE for that agency's officer role only), which
   answers a boolean. Forging a match would require the stored hash, which no
   browser-facing tier ever sees. The raw national ID is never stored, logged
   or returned.
6. **Admission is the digital lane's exam-day ingress.** It advances
   `SLOT_ASSIGNED → PHYSICAL_TEST_SCHEDULED` (attributed history row, stamps
   `physical_test_scheduled_at`). Already `PHYSICAL_TEST_SCHEDULED` (a future
   SMS path) is admitted without a second transition.
7. **Field scores require admission.** field-sync refuses a digital-lane score
   for an application with no admission (`NOT_ADMITTED`, audited, never stored).
   A walk-in's on-site registration is its admission.
8. **Every scan is evidence.** `<agency>_ops.gate_admission_attempts` logs every
   attempt with its outcome, gate venue, officer and time (PII-free), in the
   same transaction. The audit log (outbox-staged) records
   `APPLICANT_ADMITTED_AT_GATE`, the status advance, and the security-relevant
   refusals (`ALREADY_ADMITTED`, `IDENTITY_MISMATCH`, `TICKET_NOT_ISSUED`) as
   `GATE_ADMISSION_REFUSED`. Wrong gate / wrong day stay in the attempts log
   only. Both tables are append-only by trigger (grants alone would be
   re-widened by rls/0001 on every bootstrap).
9. **The citizen's QR page stops showing a spent QR.** New invitation state
   `ADMITTED` carries only where and when it was used; the token is never sent
   again.

## Path
`POST /edge/v1/gate/admissions` (officer, `admission.gate`, CSRF, never retried)
→ identity-service `POST /v1/gate/admissions` → application-service
`POST /v1/applications/admissions/gate`. Each tier rebuilds the answer from a
closed allowlist; an off-contract answer is a 502, never relayed.

## Consequences
- Proven live by `services/identity-service/selfcheck/verify-gate-admission.ts`
  (51 checks: single use incl. 8 simultaneous scans → one admission; every
  refusal; permission at both tiers; raw ID never forwarded; ADMITTED read;
  append-only and agency isolation in the engine), and by the field-sync proof
  (`NOT_ADMITTED`).
- **Online only.** A gate with no connectivity cannot admit; it can verify the
  signature offline to triage, but single use needs the server. An offline
  admission queue with conflict resolution is not built.
- **Identity is the card number, sighted by the officer.** The biometric
  matcher is still a mock; when a real one lands it should become a second
  `identity_method`, not a replacement.
- **Venue is typed on the gate device.** The officer console remembers it per
  device. A per-officer post assignment would remove the typing; it belongs to
  officer lifecycle (not built).
- **Hardening item (pre-existing, not widened here):** officer roles may SELECT
  their own agency's applicants' identity rows under rls/0001, including
  `national_id_hash`. A column-level grant excluding it is worth doing once the
  accept-lock path is checked against it.
