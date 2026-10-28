# ADR-048 — Credential-to-identity binding, and criminal clearance by Irembo certificate

**Status:** Accepted · §2.1–2.2 2026-10-28 (S12a, backend PR #49); §2.3–2.5 2026-10-28 (S12b) · proposed 2026-10-25
**Deciders:** platform owner (clearance flow chosen 2026-10-25); DPO and agencies for the defaults marked *owner to confirm* (S12b took the defaults; the owner confirmed them on 2026-10-28, see §2.5)
**Relates to:** ADR-007 age, ADR-029 onboarding, ADR-030 campaign-bound submission, ADR-032 document requirements, ADR-047 G2G sandbox

## 1. Context

**A credential is only evidence if it belongs to the applicant.** Today:

- **NESA:** `NesaGateway.lookupResults(indexNumber)` returns a `NESAVerifiedPayload` with no holder name and no ID hint. Nothing visible ties the results to the applicant who typed the index number, so a valid number belonging to someone else would pass. S12a must confirm this in code and close it. The real SDMS response carries `studentNames` (`SURNAME Forename`), `gender` and `studentNationalIdHint` (first 4 and last 4 digits of the NID), which is enough to bind the results.
- **RIB:** the existing port looks clearance up by `nationalIdHash`. No such G2G interface exists today. What exists is that a citizen requests a criminal-record certificate on IremboGov and receives an application number. Anyone can then verify that number on Irembo, which returns `NAME`, `DATE_OF_BIRTH`, `ISSUED_ON`, `APPLICATION_CODE` (the certificate type), `SIGNED_BY` and `STATUS`.
- **Agencies ask for clearance differently:**
  - RDF: no criminal record;
  - RNP: never sentenced to six months or more;
  - RCS: never convicted, and not under prosecution.

  So the *content* of a clearance matters, not only its authenticity. RNP Basic says "six months **or more**" and RNP Cadet "**more than** six months" (docs/product/recruitment-announcements-2025-2026.md §9), so the rule belongs to the campaign policy, not to the agency.

## 2. Decision

### 2.1 One pure binding rule for every credential

The new package `packages/shared-identity-match` (pure, zero dependencies) exports `bindCredential(identity, claim) → BindingResult`:

| Field | Rule |
|---|---|
| Name | NFKD-normalise and strip diacritics, upper-case, then split into tokens. Compare the token **multisets**, ignoring order (`NSANZIMANA Jackson` ≡ `Jackson NSANZIMANA`). The comparison yields one of:<br>• `EXACT`: same tokens.<br>• `PARTIAL`: one side's tokens are a subset of the other's, or one token is within edit distance 1.<br>• `MISMATCH`: anything else. |
| Date of birth | Parse both `DD/MM/YYYY` and ISO dates, then compare exactly. |
| Sex | Compare exactly, where the claim states it. |
| NID hint | The first 4 and last 4 digits must equal the applicant's NID, where the claim states a hint. |

Outcomes:

- **`BOUND`:** everything present matches, and the name is `EXACT`.
- **`REVIEW`:** the name is `PARTIAL`, and nothing else contradicts. The application goes to the amber human queue, naming the field.
- **`NOT_BOUND`:** the NID hint, DOB or sex contradicts, or the name is a `MISMATCH`. The credential is refused as **"this record does not match your identity"** and the applicant may correct the number. **This is not an eligibility verdict:** the application is not rejected, and the citizen copy names no other person.

The rule never sees raw registry payloads beyond the fields above. The compared values are discarded after binding; only the outcome and the per-field result are stored.

### 2.2 NESA results are bound, then evaluated

- `NesaGateway` returns the holder fields. The eligibility service binds them against the applicant's NIDA identity **before** applying education rules.
- Real-world states map honestly:

| NESA state | Outcome |
|---|---|
| `published: false` | `PENDING`, retried, never ineligible |
| `malpractice: true` | `REVIEW` (human), never automatic |
| `resultsAggregate: null` | handled; the aggregate isn't required |

- *Default taken, owner to confirm:* `combinationLevelType: TVET` at the A2 level satisfies an "A2 / six years of secondary" requirement.
- *Default taken, owner to confirm:* the RCS 4-year science threshold (≥ 70%) is evaluated on `weightedPercent`, plus per-subject science marks where the campaign policy lists the subjects.

### 2.3 Criminal clearance by Irembo certificate

1. **Collecting the number.** For categories whose policy requires criminal clearance, the application carries a `clearanceCertificateNumber`. Its observed shape is a letter, 12 digits, then 4 letters. It's optional at submission, and the checklist shows it as outstanding until supplied.
2. **Verifying it.** The new port `ClearanceCertificateGateway.verify(number)` returns `{ authentic, type, issuedOn, holderName, holderDob, reference }` or `NOT_FOUND`. Infrastructure faults throw a retryable error. **A registry outage is never a negative verdict.**
3. **The checks, in order:**
   1. `authentic`;
   2. `type` is in the campaign policy's allowed clearance codes. This is a configurable allowlist: the exact Irembo `APPLICATION_CODE` for a criminal-record certificate must be confirmed with RIB/Irembo, and the sandbox uses a clearly named placeholder.
   3. `issuedOn` is within the policy's validity window. *Default taken, owner to confirm:* 90 days before submission.
   4. The certificate is bound to the applicant through `bindCredential`.

   An equivalence certificate (as in the captured sample) fails check 2 as **wrong certificate type**. That is useful in itself: the same port later verifies **NESA equivalence certificates** for foreign qualifications.
4. **Reading the content.** The public verification proves authenticity and holder, not the *content* of the record. Where the certificate is a clean "no conviction" type, check 2 is sufficient. If the certificate type can carry convictions, the applicant uploads the certificate PDF (ADR-032 document door), and an officer confirms the content against the agency's rule in the amber queue (`REVIEW`).
   *Owner and RIB to confirm* whether Irembo issues a distinct "no record" certificate type. If it does, there is no human step.
5. **The RIB-by-hash adapter** stays behind the same port and yields structured `CLEAR / HAS_RECORDS / UNDER_INVESTIGATION` once a real RIB G2G exists.

### 2.4 Storage (rls/0040)

The agency schemas get `clearance_certificate_verifications`, append-only. Each row holds the application, an HMAC of the reference number plus its last 4 characters, the certificate type, `issued_on`, the binding outcome per field, the verification time and the upstream trace id. **No name or DOB is stored.**

Writes go only through a SECURITY DEFINER command function, as in rls/0033 and 0034. Retention follows the application record.

### 2.5 How S12b implemented it (decisions taken)

**Confirmed by the owner, 2026-10-28** (the four defaults S12b took; each is configuration, not code):

| Decision | Default taken | Where it lives |
|---|---|---|
| Validity window | **90 days** before the submission reference date (inclusive; a future-dated certificate is outside it) | `CLEARANCE_VALIDITY_DAYS` |
| Irembo `APPLICATION_CODE` of a criminal-record certificate | A **configurable allowlist**, never defaulted; the sandbox uses clearly named placeholders `SANDBOX_PLACEHOLDER_CRIMINAL_NO_RECORD`, `…_CRIMINAL_RECORD_EXTRACT` and (for the wrong-type case) `…_NESA_EQUIVALENCE`. *Ask RIB/Irembo for the real codes.* | `CLEARANCE_ALLOWED_APPLICATION_CODES` |
| Distinct "no record" certificate type | **None unless configured**: every allowed type then goes to a human (`CLEARANCE_CONTENT_REVIEW`). The sandbox configures one placeholder to exercise both branches. | `CLEARANCE_NO_RECORD_APPLICATION_CODES` (a subset of the allowlist) |
| Sandbox SMS cost cap | **50 messages per Kigali day** per shared counter file, plus 5 per number per 15 minutes | `SMS_DAILY_CAP` (REQUIRED, no default, in production), `SMS_CAP_STATE_FILE`, `SMS_PER_NUMBER_*` |

Until policy v2 (S12c, ADR-049) the allowlist, no-record set and window are process configuration standing in for the campaign policy; the domain takes them as a `ClearancePolicy` argument, so S12c passes per-campaign values without touching the checks.

**Where the number goes: a follow-up operation, not the submission.** `attachMyClearanceCertificate` (`POST /edge/v1/me/applications/clearance-certificate`, applicant session, CSRF, not retried by the edge). The certificate usually exists only after the citizen requested it on IremboGov, so the submission would otherwise block on it, and `submitApplication`'s idempotency hash and `APPLICANT_SUBMITTED` stay untouched. The edge checks only the shape (422 `CLEARANCE_NUMBER_MALFORMED`); identity-service authenticates the session and application-service proves ownership and that the application is open (404 bare when absent or not theirs; 409 `APPLICATION_CLOSED`; 200 `ALREADY_VERIFIED`) and stages `CLEARANCE_CERTIFICATE_SUBMITTED` (topic `clearance.submitted`). The number rides in that event so a check can be retried after an outage; it is a public verification reference, never a name or ID, and is stored only as an HMAC plus its last 4 characters. `background-vetting-service` consumes it.

**The ordered checks are one pure function** (`decideClearance`): authentic (found and in force), allowed type, validity window, `bindCredential` on name and date of birth (no NID hint is printed on a certificate, so that field is `NOT_COMPARED`), then content (a no-record type is conclusive; any other allowed type is `REVIEW`). A partial name adds `IDENTITY_NAME_PARTIAL`.

**Outcomes and what each emits.**

| Outcome | Examples | Criminal gate | Events | Citizen sees |
|---|---|---|---|---|
| `CLEARED` | clean, bound | `CLEARED` | `RIB_VETTING_COMPLETED` (`source: IREMBO_CERTIFICATE`) + audit | VERIFIED |
| `REVIEW` | record-capable type, partial name | `UNDER_REVIEW` | vetting event with `reviewReasons` + audit | UNDER_OFFICER_REVIEW, never why |
| `CORRECTION_NEEDED` | not found, withdrawn, wrong type, expired, not bound, malformed | unchanged (`PENDING`) | **audit only**: a correctable failure is not a verdict, and a `PENDING` event could regress an application that is already `CLEARED` | CORRECTION_NEEDED + a closed code |
| `PENDING` (outage) | 429, 5xx, timeout, truncated body, `status:false` that is not "not found", a sandbox answer in production | unchanged | none; a deduplicated `REGISTRY_UNAVAILABLE` record, then the error propagates so the offset is not committed and the check is retried | VERIFYING |

**Not found is distinguished from failed.** The only `status:false` answer treated as "no such certificate" is `responseCode 3105` with `data: null` (a **sandbox assumption** until a live capture of a missing number exists). Anything else that is not a well-formed found answer is an outage.

**Storage (rls/0040).** `<agency>_ops.clearance_certificate_verifications`, written only through the SECURITY DEFINER `record_clearance_verification`, owner `usrp_clearance_owner` (NOLOGIN, BYPASSRLS, never assumable), EXECUTE for `usrp_vetting_service` alone; the function re-checks the login is `usrp_app` acting as that role and that the application exists in this agency; idempotent for a redelivery. No column can hold a name or date of birth; a trigger rejects any binding key or value other than the four field names and the five per-field results. Reads: the agency officer role and `usrp_system_service` (the citizen's own checklist). `usrp_vetting_service` cannot read it back.

**Reading it.** The document checklist's RIB-verified item (`NON_CONVICTION_CERTIFICATE`) carries `clearance: {state, code, reasons}` with `state` in `NUMBER_REQUIRED | VERIFYING | CORRECTION_NEEDED | UNDER_OFFICER_REVIEW | VERIFIED`. The edge rebuilds it from an allowlist and **drops `reasons` for the citizen**. The amber queue now also lists applications whose criminal gate is `UNDER_REVIEW` or whose NESA binding needs a review (they were invisible to every queue), each with `reasons`, a closed vocabulary: `CLEARANCE_CONTENT_REVIEW`, `IDENTITY_NAME_PARTIAL`, `IDENTITY_HOLDER_UNREADABLE`, `IDENTITY_HINT_NOT_COMPARED`, `NESA_MALPRACTICE`, `NESA_LEVEL_UNKNOWN`, `NESA_DIVISION_NOT_PASS`, `CRIMINAL_RECORD_REVIEW` (the RIB-by-hash path, which records no reasons), `NESA_RECORD_REVIEW`.

**Modes.** `CLEARANCE_MODE=RIB_HASH` (default) keeps the original, database-free RIB-by-hash gate on `applicant.submitted`; `IREMBO_CERTIFICATE` starts the new consumer instead (the number arrives after submitting, so nothing runs on `applicant.submitted`). The RIB-by-hash path stays behind its own `RibGateway` port rather than the certificate port: it has no certificate to verify, and a structured `CLEAR / HAS_RECORDS / UNDER_INVESTIGATION` RIB answer will arrive through a future adapter of the same use case. The sandbox runs `IREMBO_CERTIFICATE`.

**Transport.** `IremboCertificateTransport` (HTTP, `applicationnumber` header, a sandbox G2G client bearer: never a citizen's token) is separate from the pure `mapIremboCertificate`; production changes the transport module, not the checks.

**Known gaps, deferred:** (1) an officer *decision* on a criminal `UNDER_REVIEW` application (clear or reject after confirming the certificate PDF) has no operation yet: today's `adjudicate` acts on `ADJUDICATION_REVIEW` and `DOCUMENT_REVIEW_AMBER`; the queue shows the reason, the resolution needs its own contract; (2) the certificate PDF upload for content review uses the existing document door unchanged; (3) per-campaign policy values wait for S12c; (4) the Twilio status-callback verifier (`verifyStatusCallback`) is implemented and proven but no public route receives callbacks yet (the edge exposes none).

## 3. Consequences

- Credentials stop being trusted on their number alone, which closes a real impersonation path.
- **Applicants gain a clear, correctable failure.** "This record does not match your identity" isn't a rejection.
- **The amber queue gains two reasons:** name partial match, and clearance content review. S06's queues must show both.
- **The edge contract gains a field.** `submitApplication` (or a follow-up `attachClearanceCertificate` operation) carries the number. The frontend apply wizard and checklist need a follow-up change after the contract merges.
