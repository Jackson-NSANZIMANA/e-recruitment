# B2 — On-device biometric capture (Field Station) → B3 — Evaluation and shadow mode

## B2 — On-device capture, liveness and card-portrait matching
**Phase 3 · frontend · depends on S08 (Field Station gate, device key) and B1 (evidence contract)** · Branch `feat/b2-biometric-capture` · Reserved: **ADR-FE-017**

### Why
B1 defines biometric *evidence*. B2 produces it, on the tablet, before NIDA's portrait service exists, without a single image ever leaving the device. It also corrects two existing defects:
- `checkInVerdict` maps a failed match to `REFUSE`. It must become *manual identity required*.
- The consent copy mentions fingerprints, which are never collected.

### Pipeline (ADR-FE-017)
1. **Notice and consent:** accurate trilingual copy ("a photo of your face and of your ID card's portrait are compared on this tablet; no image is kept or sent; you may decline without consequence"), with the DPO-approved basis. Decline → `NOT_ATTEMPTED / DECLINED` → manual identity.
2. **Card-portrait capture:** guided framing of the physical National ID card; detect and crop the portrait region; quality checks (blur, glare, size). Failure → retake, or `NOT_ATTEMPTED / CARD_UNREADABLE`.
3. **Live capture with active liveness:** a randomised challenge (for example blink, then turn left) tracked by face landmarks; the result is a liveness score. A passive photo or screen replay should fail the challenge.
4. **Match on device:** compute face embeddings for the card portrait and the live face, take their similarity, and map it through the **threshold-policy version** to `MATCH | NO_MATCH | INCONCLUSIVE`.
5. **Evidence:** build `USRP-BIO-EVIDENCE.v1` (scores, model and version, threshold-policy version, mode, outcome, `consentState`), sign it with the device key (`field-ledger` `SignerPort`) and submit it with B1's operation. In `SHADOW` mode the officer sees nothing; in `ADVISORY` mode they see it as evidence beside the admission.
6. **No retention:** frames live only in memory. Stop the media tracks and clear canvases and buffers immediately after scoring. Never write to IndexedDB, the cache or logs. There is no image field in the evidence (B1 refuses one anyway).

### Model selection spike (first task; a blocking review)
- Landmarks and liveness: **MediaPipe Face Landmarker** (Apache-2.0) is a candidate.
- Face embedding: **licence review is mandatory before any choice.** Many widely used face-recognition weights are licensed for **non-commercial or research use only**, which is unacceptable for a government deployment. Shortlist only models whose **weights** (not just code) carry a permissive licence. Record the licence evidence in ADR-FE-017.
- Runtime: ONNX Runtime Web or TF.js, WASM/WebGPU. **Budgets:** model download size, time-to-first-score on the managed Android model (S08 decision), memory. The model is lazy-loaded only on the gate station and stays outside the main bundle-size budget (it gets its own budget).
- Accuracy is **not** claimed by B2. It is measured by B3. B2 ships behind `SHADOW` until B3 reports.

### Test strategy
- Unit: the liveness challenge state machine; the similarity → outcome mapping per policy version; evidence canonicalisation and signing (deterministic test vectors shared with B1's verifier).
- E2E: Playwright with `--use-fake-device-for-media-stream` and **synthetic face video** (generated or licensed-synthetic only; **never images of real people**). Cases: match, no-match, replay attempt, decline, camera denied, card unreadable.
- Live: persona A at the field-station gate produces a signed SHADOW evidence row (visible in B1's proof query, invisible to the officer); a no-match fixture forces the supervised manual-identity flow.

### Exit gate
- [ ] ADR-FE-017 records the licences of every model and asset.
- [ ] No frame is persisted or sent (network log assertion in E2E, plus code review).
- [ ] `REFUSE` is gone from the model; a no-match always leads to manual identity.
- [ ] CI green on the PR head; status board updated; B3 unblocked.

### Session starter
```text
You are a principal frontend and computer-vision engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Frontend: ~/Documents/projects/e-recruitment-software/e-recruitment-ui; backend for reading and running: ../e-recruitment.

This is session B2 — On-device biometric capture. Read your kit e-recruitment/docs/program/sessions/B2-B3-biometric-capture-and-evaluation.md (part B2), the backend's docs/program/README.md and quality-workflow.md, ADR-037 and the B1/S08 hand-offs; follow them.

Start with the model-selection spike and the licence review (weights must be permissively licensed for government use; record the evidence) and ask me before adopting any model. Then build, in the Field Station gate: accurate trilingual notice/consent, card-portrait capture, active liveness, on-device matching mapped through the threshold-policy version, and device-signed USRP-BIO-EVIDENCE.v1 submitted via B1 — with no frame ever persisted or sent, SHADOW by default, and a no-match always leading to supervised manual identity (remove REFUSE).

Use ADR-FE-017 only. Synthetic faces only, never real people. /security-review is mandatory. Done = CI green on the PR head, live SHADOW evidence for persona A, status board updated, hand-off note for B3.
```

## B3 — Evaluation, thresholds and shadow-mode reporting
**Phase 3 (end) · backend tooling plus docs · depends on B2** · Branch `feat/b3-biometric-evaluation` · Reserved: **ADR-044**

### Why
A biometric threshold chosen without measurement is a guess, and a guess that falls differently on different groups of people is a fairness failure. No mode beyond `SHADOW` is allowed until this session reports.

### Delivers
- `tools/biometric-eval`: an offline evaluation CLI. It runs B2's exact pipeline (same model versions) over an **approved evaluation dataset** (licensed, with consent and with demographic labels where lawful) and reports:
  - FMR/FNMR curves;
  - liveness attack-detection rates;
  - performance by lighting and device;
  - **per-group error-rate disparity**, with minimum group sizes enforced.

  The output is a signed report artefact.
- A **threshold-policy version** proposal per agency (ADR-044), stored as versioned configuration that B1 records in every evidence row. The owner chooses, informed by the report; engineering does not.
- **Shadow-mode report** from pilot or rehearsal evidence: outcome distribution, `NOT_ATTEMPTED` reasons, and agreement with officers' manual identity decisions. Aggregates only, minimum cell sizes, feeding S11a and S13 dashboards.
- **Promotion criteria** written down: what evidence is required to move an agency from `SHADOW` to `ADVISORY`. `AUTOMATIC` stays out of scope.

### Exit gate
- [ ] An evaluation report exists for the shipped model version, including disparity metrics.
- [ ] ADR-044 lists the threshold proposal and the promotion criteria, for owner and DPO approval.
- [ ] Status board updated.

### Owner, DPO and legal decisions
- The evaluation dataset source and licence (never scraped)
- The lawful basis for demographic analysis
- Who approves promotion from SHADOW to ADVISORY

### Session starter
```text
You are the biometrics evaluation and fairness engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Repos: ~/Documents/projects/e-recruitment-software/e-recruitment and .../e-recruitment-ui.

This is session B3 — Biometric evaluation and shadow mode. Read your kit e-recruitment/docs/program/sessions/B2-B3-biometric-capture-and-evaluation.md (part B3), docs/program/README.md and quality-workflow.md, ADR-037, ADR-FE-017 and the B2 hand-off; follow them.

First ask me the dataset source/licence and the lawful basis for demographic analysis. Then build tools/biometric-eval running B2's exact pipeline to produce FMR/FNMR, liveness attack detection and per-group disparity with minimum group sizes; propose versioned threshold policies per agency and written promotion criteria from SHADOW to ADVISORY in ADR-044; and produce an aggregate shadow-mode report.

Use ADR-044 only. Done = an evaluation report for the shipped model version, ADR-044 for owner/DPO approval, status board updated, hand-off note.
```
