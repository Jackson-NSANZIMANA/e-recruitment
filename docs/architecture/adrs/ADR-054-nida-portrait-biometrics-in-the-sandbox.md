# ADR-054 — NIDA-portrait face matching, built and proven in the sandbox

**Status:** **Proposed** (2026-11-05). Nothing in it is built. It needs the owner's decisions in §5, and the DPO's sign-off for real subjects (§4), before any code.
**Relates to:** ADR-037 biometric identity evidence (this extends §2 "Reference sources"), ADR-047 G2G production sandbox, ADR-034 single-use gate admission, ADR-003 device signing.

## 1. Context

ADR-037 built biometrics as *evidence, never a verdict* at the exam gate. It has three reference sources:

- **`CARD_PORTRAIT`** is designed: the tablet photographs the portrait on the physical card and matches on the device. The server side is built; the tablet pipeline (B2) is not.
- **`NIDA_PORTRAIT`** is a port that **fails closed** (`NidaPortraitMatcher` rejects every call), because NIDA's portrait service is not authorised.
- **`NONE`** means manual identity only.

The owner's direction (2026-11-05): the platform is meant for government deployment, so the NIDA-portrait path must be built and proven against a government-identical sandbox *before* authorisation, not designed only on paper after it.

What already exists to build on:

- The Irembo identity record the sandbox serves (`nida-irembo` simulator, ADR-047 §3.2) carries a base64 JPEG `photo`, as the real one does.
  - For a **consented private subject** (ADR-047 §3.5), that is the person's real portrait from their own identity capture.
  - For the **synthetic population**, it is a generated placeholder that is not a face (`population/portrait.ts`).
- `BiometricMatcher` (server-side scoring port) and `ReferenceSource` (`SERVER_MATCH` status) already model a server-side source.
- The evidence pipeline already runs: device-signed records, threshold policy `BIO-THRESHOLDS.v1`, append-only storage, supervisor confirmation, OFF/SHADOW/ADVISORY modes.

**No NIDA face-match interface has been observed.** Every wire detail below is a **sandbox assumption** until NIDA (or RISA) publishes or authorises one. ADR-047 §3.2's rule, "simulators copy observed interfaces", cannot be met yet, and the simulator says so in its responses and its docs.

## 2. The two ways a NIDA portrait can be used

| | **A. Registry match (NIDA scores)** | **B. Device match (portrait sent to the tablet)** |
|---|---|---|
| Flow | The tablet captures a live face → biometric-service → NIDA 1:1 match API → a score comes back. The live capture is deleted once scored. | biometric-service fetches the NIDA portrait → sends it to the enrolled tablet → the tablet matches and sends a signed evidence record. |
| What leaves the tablet | **One live face image** per attempt, to our server and on to NIDA | Nothing biometric (as ADR-037 §3 requires) |
| What reaches the tablet | Nothing | **The registry portrait** of each candidate |
| Fits | The handbook (§8: "the live face vector is sent to NIDA for 1:1 match; NIDA returns a score"), and the existing `NidaPortraitMatcher` / `SERVER_MATCH` | ADR-037 §3 as written |
| Main risk | A face image transits our server: retention, logging, breach. ADR-037 §3 must be amended. | Registry portraits on field tablets: a stolen tablet leaks faces. NIDA is unlikely to authorise portrait export. |

**Proposed: A.** It is how a national identity registry normally offers verification (it keeps its portraits and returns a score), and it is what the handbook and the existing port already describe. B would need NIDA to authorise *bulk portrait release to devices*, a larger ask than a match service.

## 3. Proposed design (option A)

### 3.1 Production code (inert until authorised)

- **`NidaFaceMatchGateway`**, a new adapter behind `BiometricMatcher`.
  - It sends the live capture and the applicant's NIDA lookup key to the NIDA match endpoint, and receives `{ livenessScore?, matchScore, requestId }`.
  - Its transport is separate from its mapping, as with the Irembo adapters, so the eventual real interface replaces one module.
- **The capture is ephemeral.**
  - The live JPEG is held in memory for the single request and never written to disk, a database, MinIO, a log or an event.
  - It is zeroed after the response. Only integer scores enter the existing evidence record and threshold policy.
  - The request body is size-capped (for example 512 KiB), JPEG-only, and EXIF-stripped before forwarding.
- **Opening the source stays a code change, not a flag.**
  - `FixedReferenceSources` gains `NIDA_PORTRAIT: SERVER_MATCH` **only in the sandbox profile** (`USRP_ENVIRONMENT=sandbox`).
  - In production it stays `NOT_AUTHORISED` until a further ADR records the G2G authorisation and lawful basis.
  - The ADR-047 fences apply: production refuses a simulator host and any `x-usrp-sandbox` answer.
- **Identity binding.** The match runs against the applicant of the admission ticket (ADR-034), never against an identity typed at the gate.
- **The gate rules are unchanged.** The outcome feeds ADR-037 §1 exactly as `CARD_PORTRAIT` does: MATCH admits; NO_MATCH or INCONCLUSIVE goes to supervised manual identity; a decline or failure admits without prejudice. **Still no automatic mode.**

### 3.2 The sandbox NIDA face-match simulator (`nida-face-match`, in `tools/g2g-sandbox`)

- It answers the assumed endpoint with the Irembo-style envelope, a behaviour profile (latency, 429, 503, timeouts) and the `x-usrp-sandbox` stamp, like every simulator.
- **Synthetic people:** a deterministic score from the persona's scenario (`MATCH`, `NO_MATCH`, `INCONCLUSIVE`, `LIVENESS_FAIL`, `REFERENCE_UNAVAILABLE`). Their portraits are not faces, so a real matcher would be meaningless for them.
- **Consented private subjects (owner, Vanessa):** a **real face comparison** between the live capture and the portrait in their own identity capture, so the owner can see true matches and true non-matches on real faces.
  - It runs inside the simulator, on the owner's machine, and never in a USRP service.
  - Only the subjects in `consent.json`, whose basis must name biometric processing (§4), are compared. Everyone else gets the scenario score.
- **The model (owner decision, §5).** It must be open-weights with a licence that permits government use, pinned by hash, and downloaded by the operator, never committed. It runs under ONNX Runtime in the simulator process. The candidate list and licences are checked before choosing; several popular face-recognition weights are non-commercial only, which would rule them out.

### 3.3 The tablet capture (B2, field-station)

- **Consent screen first.** It is built from ADR-037 §12, consent-or-decline, and corrects the old "fingerprints" copy. A decline records `CANDIDATE_DECLINED` and goes to the card check without prejudice.
- **Capture.** The camera is used through `getUserMedia`, at the front-door station, after the QR and the card number pass.
  - One still is taken, with a simple quality gate (face present, size, blur).
  - It is sent once over the existing authenticated edge, to a new typed operation `matchNidaPortrait` (no retry, as for every write).
- **Liveness.** It is either NIDA's (if their service offers it) or an on-device check. For the sandbox, a scripted challenge (turn the head; the face must move across a sequence of frames) is proposed as a placeholder, clearly labelled as such until B3 evaluates a real method.
- **Result.** The officer sees MATCH, NO_MATCH, INCONCLUSIVE or NOT_ATTEMPTED in ADVISORY mode only. In SHADOW mode nothing is shown.

### 3.4 What stays exactly as ADR-037 decided

- Evidence is never a verdict.
- The supervisor confirms through their own session.
- Modes are per agency and default OFF.
- Thresholds are placeholders until B3.
- Retention follows the application record.
- Every score row is device-signed and append-only.

## 4. Data protection (DPO sign-off required)

- **The data is special-category.** A live face image and a NIDA portrait are biometric data under Law N° 058/2021.
  - Option A processes the live image on our server for the length of one request.
  - In the sandbox, the simulator also processes the real portraits of the owner and Vanessa.
- **The sandbox basis is explicit consent** by each real subject, recorded in `consent.json` with a basis that names "biometric face comparison in the sandbox". A subject without that basis is never compared.
- **Production basis:** to be decided (consent-or-decline as in ADR-037 §12, or a statutory necessity basis), together with the G2G authorisation. This ADR does not decide it.
- **DPIA rows to add:**
  - the transit of the live image through biometric-service;
  - the simulator's processing of real portraits;
  - the deletion guarantees.

## 5. Owner decisions needed before building

1. **The architecture:** A (NIDA scores, proposed) or B (portrait to the device).
2. **Real-face comparison in the sandbox** for the owner and Vanessa: yes or no, and their consent wording.
3. **The face model:** approve a candidate after a licence check (open-weights, licence permits government use), or keep the synthetic scores only for now.
4. **Liveness for the pilot:** the placeholder scripted challenge in the sandbox, or wait for NIDA's.
5. **Build order:** the B2 tablet capture first (it serves `CARD_PORTRAIT` too), or the NIDA path first.

## 6. Consequences

- The NIDA-portrait path becomes **provable end to end** in the sandbox (tablet → edge → biometric-service → simulator → score → evidence → gate) while production stays fail-closed.
- When NIDA authorises a service, the cutover is the transport module plus one line in `FixedReferenceSources` behind a new ADR, as with Irembo certificates.
- ADR-037 §3 ("no image leaves the device") gets one bounded exception for `NIDA_PORTRAIT`, written into ADR-037 when this ADR is accepted.
