# USRP full-system evaluation — 2026-10-29

The owner asked to wake every unit of the system on one machine, production-shaped, with the G2G sandbox
treated as the government APIs, and then rate how far the build is from a deployable system.

- **Code evaluated:** `main` plus the open drafts: BE #53 (S12c) and #55 (S08 status row), FE #45 (S12c UI) and #46 (S08 screens).
- **How it was booted:** `pnpm sandbox:full` (this PR). See `infrastructure/sandbox/full.sh`.
- **Machine:** one laptop with 7.6 GB of RAM and 4 cores.

Each rating says how far a unit is from what a **national deployment** needs, judged against `ROADMAP.md`'s M0–M5. A rating is not
"does it boot": every unit below boots.

## 1. What was proven live

| Proof | Result |
|---|---|
| One command boots 16 units | 12 services + simulators + edge + 3 production bundles, cold start in 3 min; `--down` leaves no process or container behind |
| Citizen journeys through the real edge | 24/24 on the first run (RDF, RNP basic, RCS junior, RCS officer 4y, clearance matrix 10/10); a re-run failed one RNP persona only because the evaluator had uploaded documents to it, which correctly holds the pass |
| Production boot posture | every service `NODE_ENV=production`, fresh secrets, dev adapters refused, server biometric matcher fails closed |
| Kafka event flow | 582 immutable audit records, 25 submissions vetted through NIDA, NESA and age |
| Document door | clean PDF stored in MinIO; disguised files refused; EICAR in a PDF stream refused by ClamAV with an immutable audit record |
| Real SMS | the owner's own OTP delivered by Twilio (`delivered`), sign-in completed; every other destination refused before Twilio is called |
| Agency isolation | the RDF administrator receives only RDF rows; the RNP and RCS tables hold rows of their own |
| Production bundles | the officer console signs in on its own origin, reads all six dashboard sources, and serves its service worker |

## 2. Defects found (and their state)

| # | Defect | Where | State |
|---|---|---|---|
| D1 | `rnp_ops`/`rcs_ops.applications` lack `sms_notification_status`, which only `rdf_ops` has: an RNP/RCS slot invitation is sent but the application never leaves `SLOT_ASSIGNED`, and the event goes to the dead-letter queue | migration 0000, application-service | **open** (on `main`) |
| D2 | Irembo 429/503: six retries in ~16 s, then the event goes to the dead-letter queue; nothing re-drives it, so the citizen stays at "verifying" | background-vetting | **open** |
| D3 | Real Twilio (~12 s) outlasted the edge's 8 s timeout: the citizen saw 503 although the code had been sent | identity-service | fixed (bounded 2 s wait) |
| D4 | Phone spellings `+250 0…`, `+250 (0)…`, `00250…`, dots and brackets refused; a malformed shape answered a generic error | identity, shared-sms, edge | fixed |
| D5 | `sandbox:down` killed recorded PIDs without checking them; after a reboot those PIDs can belong to anyone | g2g-sandbox launcher | fixed |
| D6 | The sandbox had no destination guard for real SMS; the synthetic population has well-formed MTN numbers | shared-sms | fixed (`SANDBOX_SMS_ALLOWED_TO`) |
| D7 | forensics `400 INVALID_DOCUMENT_TYPE` reaches the citizen as `503 UPSTREAM_UNAVAILABLE` | identity document door | **open** |
| D8 | A second upload of the same document type returns the first `documentId`; the corrected file is not stored | document door | **open** (confirm the intent) |
| D9 | The sandbox edge listens on `0.0.0.0`, not loopback only | edge / sandbox profile | **open** |
| D10 | No officer operation resolves a criminal-clearance `UNDER_REVIEW` (the amber queue shows it, nothing acts on it) | application-service + S06 | **open** (known since S12b) |
| D11 | `POST /field-sync/scores` answers 500 for a non-UUID `capturingOfficerId`, and the edge session carries no officer subject (four-eyes cannot be checked) | field-sync, edge | **open** (reported by S08, not re-verified here) |

## 3. Construction rating

### 3.1 Units

| Unit | Rating | Built and proven | Missing or incomplete |
|---|---|---|---|
| identity-service | 85% | NIDA onboarding, OTP, sessions, NIDA pre-fill, erasure, clearance attach, document door proxy | real NIDA authorisation; D7, D8 |
| eligibility-service | 85% | age and academic rules from policy v2, six real campaigns | HEC-backed categories have no sandbox persona |
| application-service | 75% | lifecycle, projections, adjudication, amber queue | D1, D10 |
| background-vetting-service | 70% | NIDA, NESA, RIB, Irembo certificate flow, fuzzy match to amber | D2 (no re-drive); HEC path unexercised |
| scheduling-service | 75% | slots, signed QR invitations | S14 relocation and superseding invitations |
| notification-service | 70% | Twilio channel, cost cap, per-number limit; real delivery proven | status-callback route, stable messageKey on redelivery |
| field-sync-service | 65% | online score capture, conflicts, device fleet | D11; durable offline (S15) |
| biometric-service | 35% | evidence contract, signature check, thresholds, modes, SHADOW storage | no liveness or face model anywhere (B2), no evaluation (B3), NIDA portrait not authorised |
| document-forensics-service | 65% | magic-byte admission, ClamAV, MinIO, audited malware refusal | not in the default sandbox (opt-in here); perceptual tier deferred; D7, D8 |
| audit-service | 75% | immutable audit trail on Kafka and Postgres | audit explorer (S13) |
| iam-service | 85% | officer lifecycle, four-eyes activation release, roles and permissions | SoD ratification (owner) |
| edge-gateway | 85% | 68 operations, CSRF, rate limits, session-scoped agency, multipart composition | D9; officer subject in the edge session (D11) |
| applicant portal | 65% | sign-in, apply, documents, clearance number, sandbox banner, NIDA pre-fill | citizen timeline and notices (S10a/b); assisted desk (P1) |
| officer console | 70% | workspace, queues, staff admin, Campaign Studio, Administration dashboard | D10 screen; control room (S13); relocation (S14); paper reconciliation (P1) |
| Field Station | 50% | online screens: setup, physical, medical, supervisor, conflicts | durable offline (S15); on-device biometric capture (B2); enrolment flow ownership |
| G2G sandbox | 90% | 6 simulators, 2,059 synthetic citizens, 59 personas, fault switches, private persona, real-SMS opt-in | HEC personas; documents in the default profile |

### 3.2 Areas and the overall figure

| Area | Weight | Rating | Basis |
|---|---|---|---|
| Core services (12) | 35% | 72% | average of §3.1 |
| Applications (3) | 20% | 62% | average of §3.1 |
| Government integrations | 10% | 55% | every adapter built and contract-proven on the sandbox; only Twilio is real; NIDA, NESA, HEC, RIB, Irembo authorisations pending |
| Production platform | 15% | 10% | staging and deployment (S07) not started, observability (S11a) is `/version` only, backup and restore (S11b) absent; signed images and supply chain (S03) done |
| Assurance | 10% | 18% | security reviews per session, Trivy, protected mains; no penetration test (S16), no load or failure drills (S17), no pilot pack (S18) |
| Biometrics | 5% | 35% | §3.1 |
| Governance decisions | 5% | 25% | pilot agency, district and tablet decided; SMS live; DPO, hosting, SoD, SLOs, ADS licence, model licence open |
| **Overall: deployable system** | 100% | **≈ 50%** | weighted |

Read the figure two ways. As **application functionality** (services and apps only), the build is about **68%** complete. As
**a system that can be deployed and defended in production**, it is about **50%**: the remaining weight is mostly the production
platform and assurance, which have barely started.

## 4. Strategic plan

The order follows `ROADMAP.md` §8.3. Two agent sessions run at a time.

**Phase 0 — close what this evaluation opened (about 1 week, before new features).**
1. D1 migration for RNP and RCS, with a cross-agency selfcheck so no agency-specific column can drift again.
2. D2 a durable re-drive for clearance and vetting (scheduled retry of dead-letter events with backoff and a cap), so an outage
   ends in a result and not a stuck "verifying".
3. D10 the officer action that resolves a criminal `UNDER_REVIEW`, as a backend operation and an S06 screen.
4. D7, D8 and D9, and D11 with the S08 backend ask (an officer subject in the edge session).
5. Merge the waiting drafts: BE #53, #55 and this PR; FE #45 and #46.

**Phase 1 — M1/M2, an honest exam day (2–4 weeks).** S14 relocation, the P1 paper and assisted-desk kit, Field Station enrolment and
a rehearsed exam day in Nyagatare on the Galaxy Tab A7–A10, driven only through the UI.

**Phase 2 — M3, it runs somewhere real (3–5 weeks).** S07 provider-neutral staging (the same `sandbox:full` shape on real hosts with
TLS and loopback-only internals), S11a observability (metrics, traces, alerting on dead-letter growth), S11b backup and a timed
restore, S10a/S10b citizen timeline, a minimal S13 control room, and the real G2G adapters as each authorisation lands.

**Phase 3 — M4, pilot go/no-go (3–4 weeks).** S16 security assurance with an external penetration test, S17 load (spike at 3× the
approved scenario, 24-hour soak) and failure drills, S18 pilot pack and training, the signed G1–G9 evidence bundle.

**Phase 4 — M5, national scale.** S15 durable offline and the native client, B2 on-device liveness and face match with a licensed
model, B3 evaluation on the pilot SHADOW data to set real thresholds and move to `ADVISORY`, full S13, USSD.

**Owner and external decisions on the critical path** (`ROADMAP.md` §6; engineering cannot shorten these): the G2G authorisations
(NIDA, NESA, HEC, RIB, Irembo), hosting and Rwanda residency, the DPO sign-off (DPIA, ADR-037, retention), SoD ratification, SLOs,
RPO and RTO, the ADS licence, the biometric model licence and dataset, and the real Irembo APPLICATION_CODE values.
