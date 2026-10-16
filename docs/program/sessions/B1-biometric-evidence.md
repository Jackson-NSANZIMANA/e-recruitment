# B1 — Biometric identity evidence (backend)

**Phase 1b · backend · depends on S00 and S01 (merged; shared edge files)** · Branch `feat/b1-biometric-evidence` · Reserved: **ADR-037**, **`rls/0034_biometric_evidence.sql`**

## Why
Exam-day identity today is a **National ID number typed from the card** and checked by hash (ADR-034), plus the officer looking at the person. That is the baseline, and it stays. Biometrics can make the gate stronger and faster, and catch impostors carrying a borrowed card. This is a national security-sector system, though, so it must be built as **evidence, not as a verdict**, and it must work **before NIDA's portrait service is authorised**.

## What the code tells you
| Fact | Source |
|---|---|
| A clean, PII-free core: offline QR verification, cross-agency guard, a threshold decision (`evaluateBiometric`), scores-only `BIOMETRIC_VERIFICATION_COMPLETED` plus audit. The only matcher is `MockBiometricMatcher` (always passes); the production guard refuses it. `CaptureReference.captureRef` points at nothing: there is no capture pipeline. | `services/biometric-service/src/**` (530 lines) |
| `POST /v1/biometric/verify` exists but is **not an edge operation** | edge `openapi/edge-v1.yaml` |
| `gate_admissions.identity_method varchar(32)` exists. ADR-034: "when a real matcher lands it should become a second `identity_method`, not a replacement." | `rls/0032`, ADR-034 |
| Tablets already hold an enrolled **Ed25519 key**; the server knows its public key, agency and revocation | `public_core.field_devices` |
| The frontend model maps a failed match to `REFUSE` (**wrong**: a biometric failure must route to supervised manual identity). The consent copy claims "fingerprints" (**inaccurate**: none are collected). Both are corrected in B2. | e-recruitment-ui `features/field-ops/src/model/biometric.ts`, `i18n biometric_consent` |
| "Raw frames and vectors never stored; only liveness and match scores" | handbook §8, DPIA |

## Architecture (record it in ADR-037)
1. **Evidence, never a verdict.** A biometric result is attached to a gate admission attempt as **identity evidence**. It never refuses a candidate by itself.
   - `NO_MATCH` or `INCONCLUSIVE` → the officer must complete **supervised manual identity**: a second officer or supervisor confirms, with a reason, and the confirmation is recorded.
   - A candidate who declines or cannot be captured → `NOT_ATTEMPTED` with a reason, and manual identity, without prejudice.
2. **Reference sources**, behind a `ReferenceSource` port:

   | Source | Status |
   |---|---|
   | `CARD_PORTRAIT` | **built now.** The tablet photographs the portrait printed on the candidate's physical National ID card. |
   | `NIDA_PORTRAIT` | **port only, disabled.** It fails closed until G2G authorisation and a lawful basis exist. |
   | `NONE` | manual identity only |

3. **Where matching happens.** For `CARD_PORTRAIT`, liveness and 1:1 matching run **on the device** (B2). The tablet sends a **signed evidence record**: scores, model and version, threshold-policy version, outcome. **No image, frame, template or embedding ever leaves the device**, and the server *refuses* any payload carrying one (schema plus size limit). For the future `NIDA_PORTRAIT`, a server-side 1:1 call behind the existing `BiometricMatcher` port, with ephemeral capture deleted after scoring.
4. **Trust:**
   - the evidence record is signed with the tablet's enrolled Ed25519 key;
   - the server verifies it against `field_devices` (same agency, not revoked);
   - it binds the record to the ticket and application (and to the same admission attempt where present);
   - replays are refused (record ID unique).
5. **Modes**, configured per agency (env for the pilot; a policy-version field later):

   | Mode | Behaviour |
   |---|---|
   | `OFF` | nothing captured |
   | `SHADOW` | captured and stored, **never shown**; used to measure accuracy at the pilot (B3) |
   | `ADVISORY` | shown to the officer as evidence |

   There is **no automatic mode**: enabling one would need a new ADR and an owner and DPO decision.
6. **Storage:** `<agency>_ops.biometric_evidence`:
   - append-only (trigger), FORCE RLS, PII-free;
   - columns: id, record ID, application ID, ticket ID, admission-attempt ID, reference source, method, liveness score, match score, model ID and version, threshold-policy version, mode, outcome, not-attempted reason, device ID, key ID, officer ID, captured/received timestamps, correlation ID;
   - `gate_admissions.identity_method` gains the value `NID_CARD+BIO_CARD_PORTRAIT` when biometric evidence supports the admission. `NID_CARD` remains the default.
7. **Retention and erasure:** evidence rows follow the application's retention class (`retention-schedule.md`), are tombstoned by the existing erasure path, and the DPIA gets an engineering update (DPO to sign).
8. **Notice and consent:** the legal basis (necessity or consent) is a DPO decision. Engineering records `consentState` (`GIVEN`, `DECLINED`, `NOT_REQUIRED_BY_POLICY`) in the evidence. A decline is always an accepted path.

## Read first
ADR-034, ADR-009, ADR-003/010 (device signatures), handbook §8, `docs/compliance/dpia.md` (row "Biometric linkage"), `services/biometric-service/**`, `rls/0032_*`, the field-sync device registry adapter, baseline §15.2 (venue identity and biometrics).

## Preconditions
S01 merged (edge files rebased); backend `main` green; stack up.

## Owns
- `services/biometric-service/**`
- `rls/0034_biometric_evidence.sql`
- `services/edge-gateway/src/adapters/http/biometric-evidence.controller.ts` (new)
- application-service read projection of evidence for the officer detail (append-only)
- DPIA biometric rows (engineering draft)
- ADR-037

**Append-only:** permissions (reuse `biometric.verify`; add `biometric.evidence.read` for reviewers), shared-types events (version `BIOMETRIC_VERIFICATION_COMPLETED` to v1.1 with `method` and `referenceSource`), edge operations and OpenAPI, `run-selfchecks.sh`, `bootstrap-db.sh`.

## Work plan
1. ADR-037 (the decisions above, with the owner answers).
2. Pure domain:
   - the evidence-record schema (`USRP-BIO-EVIDENCE.v1`, canonical JSON, the signing input);
   - outcome rules (`MATCH`, `NO_MATCH`, `INCONCLUSIVE`, `NOT_ATTEMPTED`) as a function of the scores and the threshold-policy version;
   - a mode gate.

   Exhaustive unit tests, including **"no field may carry an image"** (reject any string over 1 KB, any `data:`/base64-looking value, any unknown key).
3. `rls/0034`: table(s), append-only triggers, FORCE RLS per agency, grants (biometric-service writer, officer read via projection), and an `identity_method` value check update. Add it to bootstrap.
4. biometric-service: a `RecordEvidence` use case (verify the device signature through a read-only `field_devices` adapter; agency and revocation checks; replay refusal; persist; stage the event and audit in one transaction through the outbox). Refactor `VerifyBiometric` behind `ReferenceSource` (`NIDA_PORTRAIT` adapter fails closed, `CARD_PORTRAIT` is device-attested). `MockBiometricMatcher` stays dev-only.
5. Edge:
   - `recordBiometricEvidence` (`POST /edge/v1/gate/biometric-evidence`, permission `biometric.verify`, CSRF, idempotency by `recordId`);
   - `getBiometricEvidence` for the officer application detail (permission `biometric.evidence.read`; scores, outcome, method; no device internals).
6. Gate integration: admission still succeeds on the card number. When matching evidence exists for the same attempt, it records `identity_method = NID_CARD+BIO_CARD_PORTRAIT`. `NO_MATCH` and `INCONCLUSIVE` require a `manualIdentityConfirmation` (supervisor ID and reason) before admission completes. That is an ADR-034 extension; keep its ordered-checks contract.
7. Selfcheck `biometric-service/selfcheck/verify-biometric-evidence.ts`, live. Cover:
   - a valid signed record stored;
   - a forged signature refused;
   - a revoked device refused;
   - a cross-agency device refused;
   - a replay refused;
   - an image-bearing payload refused;
   - each mode honoured (SHADOW never in an officer read);
   - `NO_MATCH` → manual confirmation required → admission;
   - events PII-free;
   - append-only enforced as the table owner.
8. Rehearsal: the `national-pilot-day` scenario declares `biometricMode: SHADOW` for RDF. Expose a dev-only signing helper in `tools/rehearsal` so the live spec can submit a signed synthetic evidence record (B2 replaces it with the real device).

## Quality bar
- `pnpm verify` green
- `/security-review` **mandatory**
- No image, frame or embedding accepted anywhere (proof)
- Capability map row: biometric check-in → 🟡 "evidence model live, on-device capture B2"

## Exit gate
- [ ] All proofs in CI on the PR head.
- [ ] ADR-037 merged; DPIA engineering draft updated (DPO sign-off tracked).
- [ ] Rehearsal records a SHADOW evidence row for persona A, invisible in the officer read.
- [ ] Status board updated; B2 unblocked once S08 lands.

## Owner, DPO and legal decisions (ask; default if no answer)
| Decision | Default |
|---|---|
| Legal basis for biometric processing at the gate | treat as consent-or-decline, decline always accepted |
| Pilot mode | SHADOW for the first pilot |
| Who may perform the manual-identity confirmation after NO_MATCH | `field_supervisor` |
| Retention of evidence rows | same as the application record |

## Session starter
```text
You are the principal backend and security engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Backend: ~/Documents/projects/e-recruitment-software/e-recruitment.

This is session B1 — Biometric identity evidence. Read your kit e-recruitment/docs/program/sessions/B1-biometric-evidence.md, then docs/program/README.md and quality-workflow.md, ADR-034 and the DPIA, and follow them.

Goal: biometrics as identity EVIDENCE, never an automatic refusal. Device-signed evidence records (Ed25519, verified against field_devices) for on-device CARD_PORTRAIT matching, a NIDA_PORTRAIT reference source that fails closed until authorised, modes OFF/SHADOW/ADVISORY, append-only PII-free storage in rls/0034, edge operations to record and read evidence, gate admission recording the second identity method, and mandatory supervised manual identity after NO_MATCH. Prove that no image, frame or embedding is ever accepted.

Ask me the owner/DPO decisions first. Use ADR-037 and rls/0034 only. /security-review is mandatory. Done = CI green on the PR head, rehearsal records a SHADOW evidence row, status board and capability map updated, hand-off note.
```
