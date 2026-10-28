# ADR-047 — G2G production sandbox: real wire contracts, simulated registries

**Status:** Accepted · 2026-10-28 (proposed 2026-10-25) · implemented by S12a (backend PR #49), extended by S12b
**Deciders:** platform owner (decisions recorded in §2)
**Relates to:** ADR-028 edge tier, ADR-029 onboarding, ADR-035 rehearsal, ADR-038 release, ADR-048 identity binding and Irembo clearance, ROADMAP M3 (S12)

## 1. Context

Production needs four external authorities: NIDA (identity), NESA (A-level results), RIB/NPPA (criminal clearance) and an SMS operator. None of the G2G agreements exist yet (ROADMAP §6 #1), and they have the longest lead time in the programme.

The current mocks (`infrastructure/docker/mocks/{nida,nesa,rib,hec}`) invent their own contract: HMAC-signed POSTs keyed by a `nationalIdHash`. **No real Rwandan registry answers that way.** Every adapter built against them will be rewritten at cutover, and the domain has never met real-world data quirks.

The owner has supplied real responses captured from the live systems. They are kept outside both repositories, in `sandbox-demo/`:

| Authority | Real interface observed | What it teaches |
|---|---|---|
| NIDA, via IremboGov | `GET https://api.irembohub.com/auth/v1/user-profile-with-identity-info` (citizen OAuth bearer; `portal: citizens-portal`) | Envelope `{status, message, responseCode, timestamp, traceId, data}`. `data.identityInfo` has `forename`, `surname`, `dateOfBirth` as `DD/MM/YYYY`, `sex` `MALE`/`FEMALE`, a full administrative address (`province` › `district` › `sector` › `cell` › `village` + `villageId`), `fatherName`, `motherName`, `civilStatus`, `documentNumber` (spaced), `dateOfIssue`/`dateOfExpiry`, `citizenStatus`, and the base64 JPEG `photo` and `signature`. `userProfileDto` carries `identificationNumber` and the verified phone. |
| NESA, via SDMS | `GET https://rne.sdms.gov.rw/api/v1/public/results/by-index?indexNumber=…` (public, no auth) | `studentNames` as `SURNAME Forename`; `studentNationalIdHint` masked as the first 4 and last 4 digits (`NNNN********NNNN`); `gender`; `division` (`PASS`…); `combinationLevelType` (`TVET`…); `combination`; `weightedPercent`; `published`; `malpractice`; `attendedSchool`; `academicYear` `2024/2025`; `rawMark[]` with `markPercent`, `letterGrade`, `subject.subjectName`, `numberOfPeriods`; `resultsAggregate` may be `null`. |
| Certificates (RIB/NPPA clearance, NESA equivalence…), via IremboGov | `GET https://irembo.gov.rw/irembo/rest/public/request/verify-certificate-by-application-number` (header `applicationnumber`; citizen bearer) | `{status, data:{ISSUED_ON (DD/MM/YYYY), STATUS, REFERENCE_NUMBER, SIGNED_BY, DATE_OF_BIRTH, APPLICATION_CODE, NAME}, responseCode "3104", message "Dosiye yabonetse" (Kinyarwanda), responseEncrypted, traceId}`. `APPLICATION_CODE` names the certificate type, so the same endpoint verifies an equivalence certificate as well as a clearance. Certificates also carry a verification QR. |
| SMS (sandbox operator) | Twilio `POST /2010-04-01/Accounts/{AccountSid}/Messages.json` (form-encoded `To`, `From`, `Body`; basic auth) | E.164 numbers (`+2507…`); message SID; status callbacks; trial accounts deliver only to verified numbers. |

**Two of these are citizen-session APIs, not G2G APIs.** The Irembo identity and certificate endpoints answer to *the citizen's own* bearer token. USRP must never hold, request or relay a citizen's Irembo credentials. The production NIDA and certificate interfaces will be G2G channels (through RISA/IremboGov interoperability), whose transport will differ. The sandbox therefore mimics these **payloads and semantics**, not their authentication. Each adapter isolates the transport behind its existing port.

## 2. Owner decisions (2026-10-25)

1. The owner's real NIDA/Irembo record, NESA results and phone may be used **only as a local private persona**. It is loaded at runtime from outside both repositories and is never committed, logged, fixtured, uploaded to CI or copied into a database dump.
2. The supplied Irembo certificate sample belongs to a third person. **Shape only:** no name, date of birth or reference number from it may appear anywhere.
3. Criminal clearance moves to the **Irembo certificate flow** (ADR-048).
4. Twilio sends real SMS **only when opted in** (`SANDBOX_SMS=twilio`, credentials from an env file outside git). The default is a Twilio-compatible emulator.

## 3. Decision

### 3.1 A sandbox environment, distinct from dev and production

`USRP_ENVIRONMENT=sandbox` is a third runtime profile. It runs the **production boot guard in full** (no dev adapters, production-grade secrets, `secureCookies`, CSP), with two documented differences:

- G2G and SMS base URLs may point at **fenced simulators**.
- The SPAs carry a persistent **SANDBOX** banner, like the rehearsal marker (ADR-035).

Fences work in both directions, and each is proven by a selfcheck:

- A simulator refuses to start unless `USRP_ENVIRONMENT=sandbox` (or `development` for CI proofs), and it answers every response with `x-usrp-sandbox: 1`.
- A production process refuses any G2G base URL whose host is a simulator host, and any response carrying `x-usrp-sandbox`.
- A sandbox process refuses the real registry hosts (`*.irembohub.com`, `irembo.gov.rw`, `rne.sdms.gov.rw`). The one exception is the explicit live-NESA passthrough (§3.6).

### 3.2 Simulators speak the real wire format

`tools/g2g-sandbox/` holds one dependency-free Node HTTP server (on `shared-http`) that mounts four simulators. Their paths and payload shapes copy the observed interfaces byte for byte:

| Simulator | Route (as in production) | Notes |
|---|---|---|
| `nida-irembo` | `GET /auth/v1/user-profile-with-identity-info` | Takes a sandbox **G2G** credential (`Authorization: Bearer <sandbox client token>`, `x-usrp-subject: <NID>`) and never a citizen token. Answers the exact Irembo envelope. |
| `nesa-sdms` | `GET /api/v1/public/results/by-index?indexNumber=` | Public, as in production. |
| `irembo-certificates` | `GET /irembo/rest/public/request/verify-certificate-by-application-number` | Header `applicationnumber`. Answers the exact envelope, including Kinyarwanda `message` strings and `responseCode`. |
| `sms-twilio` | `POST /2010-04-01/Accounts/{sid}/Messages.json` | Twilio-compatible emulator with message SIDs, status progression (`queued → sent → delivered/undelivered`) and an inbox file (replacing `.dev-sms`). |

The existing hash-keyed mocks stay until S12a moves the adapters across. They are then retired in the same PR that removes their last caller.

### 3.3 Real-world behaviour is part of the contract

Each simulator has a **behaviour profile**, set per persona and overridable per request in sandbox, so that every failure the baseline names (§15.8–15.9) can be rehearsed:

- **Latency:** a log-normal distribution per authority (p50 and p95 configurable).
- **Faults:** HTTP 429 with `Retry-After`; 503 maintenance windows; timeouts; truncated bodies; `status:false` envelopes with a 200 status code (observed Irembo style).
- **Data quirks:**
  - `DD/MM/YYYY` dates;
  - `SURNAME Forename` ordering, diacritics (`Béata`) and case differences;
  - spaced document numbers;
  - `resultsAggregate: null`, `published: false` (results not yet out), `malpractice: true`;
  - an expired ID card (`dateOfExpiry` in the past);
  - `citizenStatus` other than `NORMAL`.
- **Budgets:** a per-client token bucket per authority, as the baseline's registry call budgets require. Exceeding it yields 429, never a negative verdict.

### 3.4 A synthetic national population, faithful to the shape

`tools/g2g-sandbox/population/` generates a deterministic population from a seed.

- **Identity:**
  - Kinyarwanda surnames and given names;
  - the 5 provinces and 30 districts, which are authoritative. Sector, cell and village names are synthetic and labelled as such until the official administrative dataset is imported.
  - parents' names, civil status, issue and expiry dates;
  - **synthetic portraits and signatures** (generated placeholders, never real faces).
- **Linked records:** each identity gets consistent NESA results (index numbers in the observed shape: a 6-digit centre code, the combination code in letters, a 3-digit candidate serial and the exam year; plus a 12-digit `studentCode`, combination, school and marks) and Irembo certificates where its scenario needs them.
- **National ID numbers** follow the observed structure: `1` + birth year + sex digit (8 male, 7 female) + 7-digit serial + issue digit + 2 control digits. The control algorithm is not public, so it is **not** emulated, and no adapter may validate it. Synthetic NIDs use a documented sandbox serial block. They can never leave the sandbox (§3.1), because a structurally valid NID could belong to a real person.
- **Scenario personas** (named, stable IDs) cover every path:
  - eligible for each published category;
  - over-age by one day;
  - under-age;
  - S3-only;
  - TVET A2;
  - A0 graduate;
  - NESA name mismatch, NESA NID-hint mismatch, results unpublished, malpractice;
  - clearance valid, clearance of the wrong type (an equivalence certificate), clearance expired, clearance with a conviction, clearance name or DOB mismatch;
  - ID expired;
  - a registry 429 or 503 during submission.

### 3.5 The owner's private persona

`SANDBOX_PRIVATE_PERSONA_DIR` (default unset) points to a directory **outside** both repositories. When it is set, the sandbox overlays one identity, read at runtime, onto the synthetic population.

Mechanical guards:

- The loader refuses a path inside any git work tree.
- Values are kept in memory only. The simulators answer from them, but they are never written to the sandbox's own files, never logged (the logger redacts by field), and never included in an evidence or release bundle.
- `scripts/check-tracked-secrets.mjs` gains a **personal-data rule**. It fails CI if a tracked file contains a 16-digit NID outside the documented synthetic block, a base64 JPEG longer than 1 KiB in a JSON fixture, or an E.164 Rwandan mobile number outside the synthetic range.
- USRP's own database will, by design, store what any applicant's onboarding stores: hashed NID, encrypted name and DOB. A sandbox run with the persona uses a sandbox database, which `pnpm sandbox:reset` drops.

### 3.6 Live-NESA passthrough (opt-in)

The SDMS results endpoint is public. With `SANDBOX_NESA_LIVE=1`, the NESA adapter calls the real `rne.sdms.gov.rw` for **one allowlisted index number** (the owner's own, set locally), and the simulator answers everything else. This proves the adapter against production bytes without a G2G agreement. It is rate-limited to 1 request per minute and refused in production until the authorisation exists.

### 3.7 Production cutover changes configuration, not code

Each adapter's transport sits behind its existing port: `NidaGateway`, `NesaGateway`, `SmsChannel`, and the new `ClearanceCertificateGateway` (ADR-048). Cutover means:

- swap the base URL and credentials;
- swap the transport module if the G2G channel differs (for example mTLS or a signed JWT through the government interoperability layer);
- rerun the contract tests against the real channel.

The domain, events and UI do not change.

## 4. Consequences

- The adapters are written once, against real payloads, and real-world quirks are handled in the domain now instead of on launch day.
- **Rehearsal stays honest.** Every registry outage and quirk can be staged, and the go-live drills (S17, S18) use these profiles.
- The sandbox is a third environment to keep green. Its selfchecks join `run-selfchecks.sh`.
- **Risk: the simulators drift from the real APIs.** Mitigations: the captured shapes are stored as JSON Schemas under `tools/g2g-sandbox/contracts/`, with values stripped; the live-NESA passthrough re-validates the schema whenever it runs; cutover reruns the contract tests.
- **Risk: personal data leaks.** Mitigations: §3.5 guards, CI's personal-data rule, and no persona in CI at all (CI runs the synthetic population only).

## 5. Not decided here

- The production G2G transport for each authority (it follows the authorisations, ROADMAP §6 #1).
- Whether NIDA will return portraits over G2G for B1/B2. This is `NIDA_PORTRAIT`, still fail-closed (ADR-037).
- Importing the official administrative-division dataset (sector, cell, village) to replace the synthetic names.
