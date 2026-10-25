# ADR-048 — Credential-to-identity binding, and criminal clearance by Irembo certificate

**Status:** Proposed (design) · 2026-10-25 · NESA binding implemented by S12a; clearance flow by S12b
**Deciders:** platform owner (clearance flow chosen 2026-10-25); DPO and agencies for the defaults marked *owner to confirm*
**Relates to:** ADR-007 age, ADR-029 onboarding, ADR-030 campaign-bound submission, ADR-032 document requirements, ADR-047 G2G sandbox

## 1. Context

**A credential is only evidence if it belongs to the applicant.** Today:

- **NESA:** `NesaGateway.lookupResults(indexNumber)` returns a `NESAVerifiedPayload` with no holder name and no ID hint. Nothing visible ties the results to the applicant who typed the index number, so a valid number belonging to someone else would pass. S12a must confirm this in code and close it. The real SDMS response carries `studentNames` (`SURNAME Forename`), `gender` and `studentNationalIdHint` (first 4 and last 4 digits of the NID), which is enough to bind the results.
- **RIB:** the existing port looks clearance up by `nationalIdHash`. No such G2G interface exists today. What exists is that a citizen requests a criminal-record certificate on IremboGov and receives an application number. Anyone can then verify that number on Irembo, which returns `NAME`, `DATE_OF_BIRTH`, `ISSUED_ON`, `APPLICATION_CODE` (the certificate type), `SIGNED_BY` and `STATUS`.
- **Agencies ask for clearance differently:**
  - RDF: no criminal record;
  - RNP: never sentenced to six months or more;
  - RCS: never convicted, and not under prosecution.

  So the *content* of a clearance matters, not only its authenticity.

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

## 3. Consequences

- Credentials stop being trusted on their number alone, which closes a real impersonation path.
- **Applicants gain a clear, correctable failure.** "This record does not match your identity" isn't a rejection.
- **The amber queue gains two reasons:** name partial match, and clearance content review. S06's queues must show both.
- **The edge contract gains a field.** `submitApplication` (or a follow-up `attachClearanceCertificate` operation) carries the number. The frontend apply wizard and checklist need a follow-up change after the contract merges.
