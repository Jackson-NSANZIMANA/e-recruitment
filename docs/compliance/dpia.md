# Data Protection Impact Assessment (DPIA) — USRP

> **STATUS: DRAFT — engineering-prepared. NOT VALID until reviewed and signed
> by the project owner, the agencies' legal/data-protection officers, and —
> where Law N° 058/2021 requires — submitted to the supervisory authority.
> Nothing here is a legal opinion.**

Prepared: 2026-07-26 (from the verified state of the codebase at that date).
Scope: the Unified Security Recruitment Portal (USRP) backend — identity
verification, application processing, and erasure — for RDF, RNP, and RCS
recruitment campaigns in Rwanda.

## 1. Processing description

| Aspect | Description |
|---|---|
| Controller | The recruiting agencies (RDF / RNP / RCS) jointly, via the platform owner. **[OWNER: confirm controller/processor allocation]** |
| Data subjects | Rwandan citizens applying (or attempting to apply) for recruitment; officers operating the platform |
| Purpose | Verify applicant identity against NIDA; run each agency's recruitment funnel (academic, criminal, document, physical, medical, final decision); notify the applicant of statutory process events (exam-slot invitation; erasure decisions) via the NIDA-registered phone (ADR-021); maintain an accountable processing record |
| Legal basis | Public-interest / legal-obligation recruitment mandate of the agencies **[LEGAL: confirm precise basis per Law N° 058/2021 art. references]**; citizen's own application act |
| Recipients | The recruiting agency processing the application (cross-agency access engine-blocked); NIDA/NESA/RIB/HEC via G2G (mocks only today — see `g2g-authorization-prerequisites.md`) |
| Transfers | None outside Rwanda. No cloud processing of PII. |

## 2. Data inventory (verified against live schema)

**Direct PII — one table only: `public_core.applicant_identities`**

| Data | Column(s) | Protection |
|---|---|---|
| Full name, date of birth, home district/province | `encrypted_*` (4) | pgcrypto `pgp_sym_encrypt`, key never stored in DB, set transaction-locally |
| NIDA G2G lookup hash | `encrypted_nida_lookup_hash` | encrypted as above; NULLed on erasure |
| National ID (raw) | **never stored, never logged, never in events or responses** — platform invariant, proven by selfchecks | HMAC hash only (`national_id_hash`), key separate from NIDA lookup hash (two-hash contract) |
| Phone number | `phone_number_hash` (lookup digest) + `encrypted_phone_number` (deliverable value, ADR-021 — captured at OTP verification from the live NIDA lookup) | HMAC + pgcrypto as above; ciphertext NULLed on erasure; decrypted only by notification-service per delivery, transaction-locally. **Legal basis: necessity** — statutory notification duty in the recruitment process the citizen initiated (owner D13b, 2026-07-27); no separate consent step **[LEGAL: confirm basis]** |
| Biometric linkage | `biometric_session_id` + result flags — no biometric templates stored | session pointer only |
| Biometric identity evidence (ADR-037) | `<agency>_ops.biometric_evidence`: device-signed outcome (`MATCH`/`NO_MATCH`/`INCONCLUSIVE`/`NOT_ATTEMPTED`), integer liveness and match scores, model id/version, threshold-policy version, mode, consent state, device and key id, officer id, timestamps. **No image, frame, template or embedding is ever received or stored** (refused at the edge, the service and the column types). Pseudonymous: linked to a person only through the application → identity row. **Legal basis: consent-or-decline (owner decision 2026-10-19); a decline routes to the card check without prejudice. [DPO: confirm basis and article]** | append-only, FORCE RLS; SHADOW rows invisible to every officer; retention = application record class; identity tombstone on erasure leaves the row pseudonymous **[DPO: decide whether scores must also be destroyed on erasure]** |
| Supervised manual identity (ADR-037) | `<agency>_ops.gate_manual_identity_confirmations`: evidence id, confirming supervisor id, closed reason code, time | append-only, FORCE RLS; no free text |

**Personal data adjacent:** `applicant_sessions` (session token, IP,
user-agent — deleted on erasure); officer identity in `iam` (employment
data). **PII-free by construction:** ops-schema applications/history/scores
and `audit_log` (opaque UUIDs, statuses, scores only).

## 3. Risks and mitigations (engine-enforced unless noted)

| # | Risk | Mitigation | Residual |
|---|---|---|---|
| 1 | Cross-agency disclosure of an applicant's file | FORCE'd RLS per agency schema; officer DB roles; proven by gate selfchecks | Superuser bypass (ops-controlled) |
| 2 | Raw NID leakage | Never persisted; HMAC at ingress; selfchecks assert absence in every response body and event | Application-memory lifetime |
| 3 | PII disclosure at rest | pgcrypto encryption, single platform key from env | **Single key = single point; DEK upgrade mandated before backups (ADR-015)** |
| 4 | Unlawful retention after purpose ends | Right-to-erasure endpoint + terminal-only gate (ADR-015); retention schedule (draft) | Retention sweep not yet automated (follow-on) |
| 5 | Erasure that isn't real | Tombstone overwrite destroys the only ciphertext copy (no backups in this tier); rls/0014 freezes the tombstone irreversibly; proven live by gate #29 | WAL retention window; superuser trigger bypass |
| 6 | Unaccountable erasure decisions | EVERY attempt audited (executed AND refused, with legal ground) into engine-immutable audit log; citizen demands land in a DPO intake queue (ADR-020, owner D10) — filing and declines audited with grounds; execution stays an officer act | — |
| 6b | Irreversible destruction triggered by a hijacked citizen session | Owner D10: self-service erasure is REQUEST-intake, not execution — the OTP-strength session can demand, only an accountable officer can destroy | Officer judgment; DPO role not yet distinct from officer (ADR-020 follow-on) |
| 7 | Tampering with processing history | REVOKE + unconditional RAISE triggers on audit/history tables (rls/0002/0007) | Superuser bypass |
| 8 | G2G credential misuse | **Mocks only today. Real G2G BLOCKED on government authorization** — see prerequisites doc | n/a until authorized |
| 8b | Biometric data leaving the device or being retained | On-device matching only (B2); the server accepts a ≤4 KiB flat, closed-schema record and refuses any image-shaped value (`IMAGE_PAYLOAD_REFUSED`), proven by `verify-biometric-evidence.ts`; scores-only events | A compromised tablet app could capture locally (device management, B2/S09) |
| 8c | A face-match error excluding a candidate | Evidence never refuses (ADR-037 §1): `NO_MATCH`/`INCONCLUSIVE` → supervised manual identity by a different officer, who must be an active field supervisor of the agency (checked in the engine, rls/0034 `confirm_manual_identity`); device evidence never sets the identity's biometric verdict; decline → card check without prejudice; no automatic mode exists; SHADOW for the pilot | Supervisor judgement; thresholds are placeholders until B3 |
| 8d | Forged or replayed evidence | Ed25519 device signature verified against `field_devices` (agency, revocation, key fingerprint), ticket binding, unique record id, server-recomputed outcome | A stolen device key signs until revoked; shared `usrp_app` login (rls/0001); negative evidence arriving after admission is recorded and flagged (`afterAdmission`) but does not undo the admission |
| 9 | Officer over-collection | Officers see only their agency's rows (RLS EXISTS predicates); no PII decrypt grant to officer roles | — |

## 4. Necessity & proportionality

- Data minimisation: the PII set is the minimum to identify one citizen
  uniquely, run the funnel, and notify them of its statutory events; the
  stored contact is captured only after the citizen authenticates (OTP),
  is SMS-only (owner D13a — no email collected), and dies with the record
  (erasure + retention sweep). Scores/statuses are pseudonymous.
- Storage limitation: erasure mechanism live; retention schedule drafted,
  **periods require owner/agency sign-off**.
- Accuracy: identity data comes from NIDA at verification time, not from
  self-declaration.

## 5. Open items requiring accountable sign-off

1. Controller/processor allocation between agencies and platform operator.
2. Legal-basis article references for each processing purpose.
3. Retention periods (see `retention-schedule.md` — all TBD).
4. Whether this DPIA must be filed with the supervisory authority before
   production processing, and by whom.
5. DPO appointment.
6. **Biometric identity evidence (ADR-037, engineering draft 2026-10-19 — DPO sign-off PENDING):**
   (a) legal basis and article for consent-or-decline biometric processing at
   the gate; (b) the notice/consent text shown on the tablet (B2; the current
   frontend copy wrongly mentions fingerprints); (c) whether erasure must also
   destroy evidence scores (today: identity tombstone, row stays pseudonymous,
   retention = application record); (d) confirmation that SHADOW-mode
   collection for accuracy measurement (B3) is within the stated purpose
   (SHADOW outcomes are kept out of the audit stream; they exist only in the
   evidence table); (e) the follow-up duty for negative evidence that arrives
   after an admission (`afterAdmission` in the audit). (The citizen-facing erasure request channel is now
   BUILT — ADR-020 intake queue; the open question is who staffs it.)
