# ADR-037 — Biometric identity evidence

**Status:** Accepted (B1, 2026-10-19). Owner decisions recorded below.
**DPO sign-off: PENDING** (tracked in `docs/compliance/dpia.md` §5 and the
"Biometric evidence" rows of §2–§3). Nothing here is a legal opinion.
**Extends:** ADR-034 (single-use gate admission), ADR-003/010 (device
signatures, field-device registry), ADR-031 (permissions and separation of
duties), ADR-025 (transactional outbox).
**Supersedes:** ADR-010 §4 "biometric-pass precondition" for physical-test
completion (see §9).
**Implements:** `rls/0034_biometric_evidence.sql`, `services/biometric-service`
(`/v1/biometric/evidence`, `/v1/biometric/policy`), application-service
(`/v1/applications/biometric-evidence`, `/v1/applications/biometric-evidence/manual-identity`,
the gate admission extension), edge operations `getBiometricPolicy`,
`recordBiometricEvidence`, `getBiometricEvidence`, `confirmManualIdentity`.

## Context
Exam-day identity is the national ID number typed from the card, checked by
keyed hash in the engine, plus the officer looking at the person (ADR-034).
That stays the baseline. Biometrics can make the gate stronger, and catch an
impostor carrying a borrowed card, but this is a national security-sector
system: a face matcher's false rejection must never become a refusal, and the
platform must work before NIDA's portrait service is authorised (it is not:
`g2g-authorization-prerequisites.md`).

What existed: a PII-free decision core (`evaluateBiometric`), a scores-only
`BIOMETRIC_VERIFICATION_COMPLETED` event and a `MockBiometricMatcher` that
always passes, refused in production. `CaptureReference.captureRef` pointed at
nothing. `POST /v1/biometric/verify` was not an edge operation. Physical-test
completion was held until `applicant_identities.biometric_verified_at` was
set — which only the mock could do — so a biometric *absence* was already an
automatic refusal (§9).

## Decision

### 1. Evidence, never a verdict
A biometric result is **identity evidence** attached to an application and its
exam ticket. It never refuses a candidate by itself.

| Evidence outcome | What the gate must do |
|---|---|
| `MATCH` | admit on the card number as before; the admission records `identity_method = NATIONAL_ID_CARD+CARD_PORTRAIT` |
| `NO_MATCH`, `INCONCLUSIVE` | **supervised manual identity**: a `field_supervisor` who is not the capturing officer and not the admitting officer confirms, with a closed reason code, through their **own** authenticated session (`confirmManualIdentity`). Until then the admission answers `409 MANUAL_IDENTITY_REQUIRED`. Once confirmed it records `identity_method = NATIONAL_ID_CARD+SUPERVISOR` |
| `NOT_ATTEMPTED` (declined, capture failed, card portrait unreadable, device unavailable, no reference) | admit on the card number (`NATIONAL_ID_CARD`) **without prejudice**: nothing extra is asked of the candidate |
| no evidence, or mode `OFF` / `SHADOW` | unchanged ADR-034 behaviour (`NATIONAL_ID_CARD`) |

There is **no automatic mode**. Enabling one needs a new ADR and an owner and
DPO decision.

The confirmation is a separate authenticated act rather than a supervisor id
typed by the gate officer (the kit's sketch): a typed id proves nothing about
who confirmed. It is a **strengthening** of the kit, recorded as a deviation.

### 2. Reference sources (port `ReferenceSource`)
| Source | Status |
|---|---|
| `CARD_PORTRAIT` | **built**: the tablet photographs the portrait printed on the candidate's physical card and matches on the device (B2). The server receives a device-attested evidence record. |
| `NIDA_PORTRAIT` | **port only, fails closed**: refused with `REFERENCE_SOURCE_NOT_AUTHORISED` on the evidence path, and the legacy server-side `/v1/biometric/verify` answers `503 REFERENCE_SOURCE_NOT_AUTHORISED` in production. It opens only with G2G authorisation and a lawful basis (a new ADR). |
| `NONE` | manual identity only (`NOT_ATTEMPTED`, reason `NO_REFERENCE_SOURCE`) |

`MockBiometricMatcher` stays dev-only; production wires the fail-closed NIDA
source instead, so biometric-service now **boots** in production (it used to
refuse) with every server-side match refused.

### 3. Where matching happens; nothing biometric reaches the server
For `CARD_PORTRAIT`, liveness and 1:1 matching run **on the device**. The tablet
sends a **signed evidence record**: integer scores, model id and version,
threshold-policy version, outcome. **No image, frame, template or embedding
ever leaves the device**, and the server refuses any payload that could carry
one:

- the edge caps the body at **4 KiB** and refuses any key other than `record`
  and `signature`, any nested object or array inside `record`, any string over
  128 characters, any `data:` value and any long base64-looking value;
- biometric-service re-validates the exact closed schema (every key required,
  no unknown key, flat, typed, bounded) and the same image guard
  (`IMAGE_PAYLOAD_REFUSED`);
- every column of `biometric_evidence` is a bounded scalar with a CHECK
  constraint, so even a bypassing writer cannot store a blob.

### 4. The evidence record — `USRP-BIO-EVIDENCE.v1`
A flat JSON object; **every key is required** (nullable ones are sent as
`null`), no other key is accepted:

| Key | Type |
|---|---|
| `schema` | `"USRP-BIO-EVIDENCE.v1"` |
| `recordId` | UUID, generated on the device; globally unique |
| `applicationId` | UUID (from the exam ticket) |
| `ticketId` | the ticket id of that application's stored exam QR |
| `deviceId` | the enrolled `field_devices.device_id` |
| `keyId` | lowercase hex SHA-256 of the device public key's SPKI DER |
| `referenceSource` | `CARD_PORTRAIT` \| `NIDA_PORTRAIT` \| `NONE` |
| `method` | `FACE_1_1_ON_DEVICE` (attempted) \| `NONE` (not attempted) |
| `consentState` | `GIVEN` \| `DECLINED` \| `NOT_REQUIRED_BY_POLICY` |
| `outcome` | `MATCH` \| `NO_MATCH` \| `INCONCLUSIVE` \| `NOT_ATTEMPTED` |
| `notAttemptedReason` | `CANDIDATE_DECLINED` \| `CAPTURE_FAILED` \| `CARD_PORTRAIT_UNREADABLE` \| `DEVICE_UNAVAILABLE` \| `NO_REFERENCE_SOURCE` \| `null` |
| `livenessScoreBp` | integer 0..10000 (basis points) \| `null` |
| `matchScoreBp` | integer 0..10000 \| `null` |
| `modelId` | `[A-Za-z0-9._:-]{1,64}` \| `null` |
| `modelVersion` | `[A-Za-z0-9._:-]{1,32}` \| `null` |
| `thresholdPolicyVersion` | a registered policy, today `BIO-THRESHOLDS.v1` |
| `mode` | `SHADOW` \| `ADVISORY` (what the device believes the policy is) |
| `capturedAt` | ISO-8601 UTC instant |

Scores are **integers** so the signing input is identical on every platform
(no float formatting differences between a TypeScript and a native client).

**Signing input:** the UTF-8 bytes of `canonicalJson(record)` — keys sorted
recursively, no whitespace, `null` kept — exactly
`@usrp/shared-security`'s `canonicalJson`. The `schema` key gives domain
separation from field-score records. **Signature:** Ed25519 over those bytes
with the device's enrolled key, standard base64 (88 characters).
**Request:** `{ "record": { … }, "signature": "<base64>" }`.

### 5. Trust
- The record is verified against `public_core.field_devices`: the device must
  exist, be **of the officer's agency**, be **not revoked**, and `keyId` must
  equal the fingerprint of its stored public key (refusals: `UNKNOWN_DEVICE`,
  `DEVICE_REVOKED`, `DEVICE_WRONG_AGENCY`, `KEY_MISMATCH`, `SIGNATURE_INVALID`,
  each audited as `BIOMETRIC_EVIDENCE_REFUSED`). The record carries **no agency**:
  the agency is the officer's, from the session (`agency` is a forbidden field at
  the edge), and the device, the application and the ticket must all belong to it.
- The record is **bound** to the application and its ticket: the engine
  checks that the application exists in the officer's agency schema and that
  `ticketId` is the ticket of the QR stored on it (`UNKNOWN_TICKET`).
- **Replays are refused**: `record_id` is UNIQUE. The same record with the
  same signature answers `200 ALREADY_RECORDED` and writes nothing (a lost
  response can be retried by the device); any other body with a used
  `recordId` is `409 REPLAY_CONFLICT`.
- The server **recomputes the outcome** from the scores and the threshold
  policy, and refuses a record whose declared outcome differs
  (`OUTCOME_INCONSISTENT`).
- `capturedAt` must be within 24 hours before and 5 minutes after receipt.
- The officer (who must hold `biometric.verify`) comes from the verified
  token, re-checked in the engine as an **active** account of that agency
  holding `screening_officer`.

### 6. Threshold policy `BIO-THRESHOLDS.v1`
| Rule | Outcome |
|---|---|
| liveness < 8500 bp | `INCONCLUSIVE` (a failed liveness is not a non-match) |
| liveness ≥ 8500 and match ≥ 8500 | `MATCH` |
| liveness ≥ 8500 and match < 6000 | `NO_MATCH` |
| otherwise | `INCONCLUSIVE` |

The values are engineering placeholders until B3 measures the model on the
pilot (SHADOW) data; B3 owns ADR-044 and a new policy version. A record is
evaluated under the version it declares, which must be registered.

### 7. Modes, per agency
Configured by environment for the pilot: `BIOMETRIC_MODE_RDF`,
`BIOMETRIC_MODE_RNP`, `BIOMETRIC_MODE_RCS` ∈ `OFF` | `SHADOW` | `ADVISORY`,
default `OFF` (fail closed). A later policy-version field will replace the
environment.

| Mode | Behaviour |
|---|---|
| `OFF` | nothing is captured: the evidence operation answers `409 BIOMETRIC_OFF` |
| `SHADOW` | captured and stored, **never shown and never used**: the record response omits the outcome, the officer read cannot see the row (engine RLS), and the gate admission ignores it. Used by B3 to measure accuracy. |
| `ADVISORY` | shown to the officer as evidence; drives §1 |

A record whose `mode` differs from the agency's configured mode is refused
(`409 MODE_MISMATCH`, with the configured mode), so a device can never show a
SHADOW result. `getBiometricPolicy` tells the device the mode, the threshold
policy and the reference-source status before it captures.

### 8. Storage — `<agency>_ops.biometric_evidence` (rls/0034)
- Columns: id, record_id (UNIQUE), application_id, ticket_id, reference_source,
  method, consent_state, outcome, not_attempted_reason, liveness_score_bp,
  match_score_bp, model_id, model_version, threshold_policy_version, mode,
  device_id, key_id, record_digest (SHA-256 of the signing input), signature,
  officer_id, captured_at, received_at, correlation_id. **PII-free**: opaque
  ids, closed codes, integers. The digest and signature make every row
  re-verifiable later against the device key.
- **Append-only** by trigger (UPDATE / DELETE / TRUNCATE raise, also for the
  table owner), **FORCE RLS**.
- **Write boundary:** only the SECURITY DEFINER function
  `<agency>_ops.record_biometric_evidence(…)`, owned by the NOLOGIN, BYPASSRLS
  `usrp_biometric_evidence_owner`, EXECUTE for the new NOLOGIN
  `usrp_biometric_service` only. It re-checks the caller (`usrp_app` +
  `usrp_biometric_service`), the transaction-bound officer, the officer's live
  account, the device (agency, revocation, key fingerprint), the ticket
  binding and the replay, and inserts. As in rls/0027/0033, the
  transaction-local actor guards against substitution and the authenticated
  service remains the trust boundary for *who*; Ed25519 verification happens
  in biometric-service (the engine has no Ed25519 primitive).
- **Officer read:** the agency's officer role may SELECT rows **whose mode is
  not SHADOW** (RLS). No role can read SHADOW rows today; B3 adds an
  evaluation reader.
- `<agency>_ops.gate_manual_identity_confirmations`: id, evidence_id (UNIQUE,
  FK), application_id, ticket_id, reason_code (closed), confirmed_by_id,
  confirmed_at, correlation_id. Append-only, FORCE RLS; INSERT by the agency's
  officer role, guarded by a trigger: the evidence must be visible (not
  SHADOW), `NO_MATCH` or `INCONCLUSIVE`, of the same application and ticket,
  and the confirmer must not be the capturing officer.
- `gate_admissions.identity_method` accepts `NATIONAL_ID_CARD` (default),
  `NATIONAL_ID_CARD+CARD_PORTRAIT` and `NATIONAL_ID_CARD+SUPERVISOR`. The
  column is `varchar(32)`, so the kit's `NID_CARD+BIO_CARD_PORTRAIT` is spelt
  after the existing `NATIONAL_ID_CARD` value and the reference source.
  `gate_admission_attempts.outcome` gains `MANUAL_IDENTITY_REQUIRED`.

### 9. Gate admission (extends ADR-034, keeps its ordered checks)
Checks 1–9 are unchanged. A new **check 10** runs only after the card number
matched: the admission (as the officer's agency role, so SHADOW rows are
invisible) loads the agency's visible evidence for this application **and
this ticket**:

- any `NO_MATCH`/`INCONCLUSIVE` without a confirmation by an officer other
  than the admitting officer → `409 MANUAL_IDENTITY_REQUIRED` (attempt logged,
  audited as `GATE_ADMISSION_REFUSED`). Recording a later `NOT_ATTEMPTED` or a
  fresh `MATCH` does not clear it: only a supervisor can;
- otherwise the admission records the identity method of §1 and names the
  evidence and confirmation ids in its `APPLICANT_ADMITTED_AT_GATE` audit.

**Confirmations are an engine boundary.** The officer role has no INSERT on
`gate_manual_identity_confirmations`. A confirmation is written only through
`<agency>_ops.confirm_manual_identity(officer, recordId, reason, correlation)`,
SECURITY DEFINER (owner `usrp_biometric_evidence_owner`), EXECUTE for the
agency's officer role. It re-checks in the engine that the caller is
`usrp_app` as that role, that `usrp.manual_identity_actor_id` equals the
confirming officer, and that the officer is an **active `field_supervisor` of
this agency** (a stale token claiming the post gets `403`). SHADOW evidence
answers `NOT_FOUND`, exactly like a nonexistent record.

**Late evidence.** Check 10, `record_biometric_evidence` and
`confirm_manual_identity` take one transaction-level advisory lock per
application (`usrp.gate-identity:<applicationId>`). Evidence is therefore
either visible to the admission or known to have arrived after it. Evidence
that arrives after admission is still recorded (B3 needs it), never undoes the
admission (evidence is never a verdict), and its audit carries
`afterAdmission: true`, so a negative can be followed up by a supervisor.

**Physical-test completion** no longer requires
`applicant_identities.biometric_verified_at` (ADR-010 §4). It requires that
identity was established: a gate admission for the application, or (legacy
path, kept) a verified biometric check-in. Otherwise the SHADOW pilot, which
must never influence an outcome, would hold every candidate at
`PHYSICAL_TEST_SCHEDULED` forever.

### 10. Events and audit
- `BIOMETRIC_VERIFICATION_COMPLETED` is versioned to **`schemaVersion: '1.1'`**
  with `method`, `referenceSource`, `mode` and `recordId` (envelope
  `eventVersion` stays `1.0`; new fields are optional for consumers). It is
  emitted only for an **ADVISORY, attempted** record; SHADOW never reaches the
  identity projection. identity-service's projector **ignores v1.1**: device
  evidence must never set or clear `applicant_identities.biometric_verified_at`,
  which the legacy physical-test path reads as a verdict. Only the legacy v1.0
  server-side check-in result is projected.
- Every stored record stages one `AUDIT_ENTRY` `BIOMETRIC_EVIDENCE_RECORDED`
  (record id, mode, `afterAdmission`, reference source, method, consent state,
  and the outcome **only in ADVISORY**: a SHADOW outcome stays in the evidence
  table and never travels in the audit stream; no scores, no device key). Trust refusals stage `BIOMETRIC_EVIDENCE_REFUSED`.
  A confirmation stages `MANUAL_IDENTITY_CONFIRMED`. All through the
  transactional outbox in the same transaction (producers `biometric-service`
  and `application-service`).

### 11. Permissions (append-only)
| Permission | Granted to |
|---|---|
| `biometric.verify` (existing) | `screening_officer` — record evidence, read the policy |
| `biometric.evidence.read` (new) | `reviewer`, `field_supervisor`, `adjudicator`, `decision_authority` — read ADVISORY evidence on the officer application detail |
| `identity.manual.confirm` (new) | `field_supervisor` only |

### 12. Retention, erasure, notice
- **Retention (owner decision):** the application record's class
  (`retention-schedule.md`, "Applications + status history": 7 years,
  PII-free after the subject's tombstone).
- **Erasure:** the existing erasure path tombstones the identity row, which is
  the only link from an evidence row to a person; evidence rows then stay
  pseudonymous exactly like physical-test scores. If the DPO requires the
  scores themselves to be destroyed on erasure, that needs a narrow tombstone
  function (not built; flagged).
- **Legal basis (owner decision):** consent-or-decline. A decline is always
  accepted and routes to the baseline card check without prejudice
  (`consentState = DECLINED`, `NOT_ATTEMPTED`, `CANDIDATE_DECLINED`). Under
  this basis an attempted capture requires `consentState = GIVEN`;
  `NOT_REQUIRED_BY_POLICY` is refused (`CONSENT_STATE_NOT_PERMITTED`) until a
  necessity basis is decided.

## Owner decisions (asked and answered before B1)
| Decision | Answer |
|---|---|
| Legal basis for biometric processing at the gate | **Consent-or-decline**; a decline is always accepted and routes to manual identity without prejudice; `consentState` recorded |
| Pilot mode | **SHADOW** for the first pilot |
| Who confirms manual identity after `NO_MATCH`/`INCONCLUSIVE` | a **`field_supervisor`**, not the same officer as the gate officer, with a reason, recorded |
| Retention of evidence rows | **same as the application record** (its retention class; tombstoned by the existing erasure path) |

**DPO sign-off is still to be tracked**: legal basis article, notice text
(the frontend consent copy claiming "fingerprints" is inaccurate and is
corrected in B2), the erasure treatment of scores, and the DPIA rows.

## Consequences
- Proven live by `services/biometric-service/selfcheck/verify-biometric-evidence.ts`
  (67 checks), with the gate, field-sync and permission proofs updated.
- Rehearsal: `national-pilot-day` declares `biometricMode: SHADOW` for RDF;
  `pnpm rehearse` checks it through `getBiometricPolicy`, and
  `pnpm rehearse --biometric-shadow A` records a synthetic signed SHADOW
  record for persona A through the real edge and proves it invisible to the
  officer read (dev-only helper in `tools/rehearsal/src/biometric.ts`, until B2).
- Operators: set `BIOMETRIC_MODE_<AGENCY>` (default `OFF`); the edge reaches
  biometric-service at `BIOMETRIC_SERVICE_BASE_URL` (default
  `http://localhost:4003`). biometric-service now needs `DATABASE_URL`.
- B2 builds the on-device pipeline against §4 and `getBiometricPolicy`; B3
  evaluates SHADOW rows and replaces the placeholder thresholds.
- The supervisor confirmation needs the supervisor's own session (their
  device, or a sign-in on the gate tablet); S08/B2 design that flow.
- Residuals: `usrp_app` is shared by every backend (as rls/0001 states), so
  a compromised backend could call the definer function with an arbitrary
  officer id of an active screening officer; the device signature still has to
  verify, which only biometric-service checks. A stolen tablet key can sign
  evidence until the device is revoked; evidence alone never admits or
  refuses anyone.

## Not in scope
On-device capture and the consent screen (B2), accuracy evaluation and
threshold tuning (B3), the NIDA portrait integration (blocked on G2G
authorisation), an evaluation reader for SHADOW rows (B3), destroying scores
on erasure.
