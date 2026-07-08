# eligibility-service — HEC degree gate (education stage, part 2/2)

**Status:** DONE — proven live (HTTP slice against live PG + usrp-hec-mock), 2026-07-08.
Gate now **10/10 green**.

## The gap this closes

The education stage had only its A-Level half. `EDUCATION_REQUIREMENTS` splits every
category into a NESA (A-Level) path or an **HEC (degree/diploma) path**
(`hecVerificationRequired: true` for the university/officer/specialist categories:
`RESERVE_FORCE_UNIVERSITY`, `RESERVE_FORCE_SPECIALIST`, `CADET_OFFICER`,
`OFFICER_ONE_YEAR`, `OFFICER_ONE_YEAR_SPECIALIST`). Those categories had no verifier.
This slice builds the HEC gate, completing stage 2.

## The architectural seam it surfaced: two hashes, and neither was reachable

HEC binds a degree to its holder by matching a **G2G subject hash** —
`HMAC(NIDA-shared secret, NID)` — the token every government authority recognises for
a citizen. But USRP stored only the **internal** `national_id_hash =
HMAC(USRP-private key, NID)`, and never the raw NID. The two are different by design
(the two-hash contract), so the eligibility service — holding only an `applicantId` —
had no way to produce the hash HEC needs. Proven empirically before building
(`HMAC(dev_nida_hmac_secret, '1200380123456789')` == the HEC seed's holder hash;
the internal hash does not match).

**Resolution (owner-approved): store the G2G hash, encrypted at rest.**
- Migration **`0005_nida_lookup_hash.sql`** adds `applicant_identities.encrypted_nida_lookup_hash`
  (nullable — rows created before it predate it).
- **identity-service** captures the hash at verification (the only place that holds the
  raw NID) and writes it with `pgp_sym_encrypt` under the transaction-local
  `app.encryption_key`, exactly like the PII columns. It is a citizen-linked,
  externally-meaningful identifier, so it gets PII-grade protection — not a plaintext
  column like `national_id_hash`.
- **eligibility-service** reads + decrypts it as `usrp_system_service` via a dedicated
  `findG2GSubjectById` (decrypts ONLY the hash, not the DOB — least exposure).

This is faithful to how G2G identity federation actually works and generalises to RIB.

## Shape (hexagonal, mirrors the NESA gate)

```
POST /v1/eligibility/degree-check { applicantId, applicationId, category, hecRegistrationNumber }
  → PgIdentityReader.findG2GSubjectById  — applicant VERIFIED + decrypt G2G subject hash
                                           (null hash ⇒ G2G_SUBJECT_UNAVAILABLE, fail closed)
  → guard: EDUCATION_REQUIREMENTS[category].hecVerificationRequired  (else HEC_NOT_APPLICABLE)
  → HecHttpGateway.verifyDegree(reg, g2gHash)  — G2G-signed POST /v1/degree/verify;
        VERIFIED | HOLDER_MISMATCH | NOT_FOUND  (mismatch/not-found are return values)
  → evaluateHecEducation(category, payload)  — pure: accepted-level check + specialist-field
        match (per-agency field set); surfaces the age-exception linkage
  → publish HEC_VERIFICATION_COMPLETED (routing) + AUDIT_ENTRY (immutable decision)
```

Business outcomes → HTTP: `EVALUATED`→200, `APPLICANT_NOT_FOUND`→404,
`IDENTITY_NOT_VERIFIED`/`G2G_SUBJECT_UNAVAILABLE`/`HEC_NOT_APPLICABLE`→409,
`DEGREE_NOT_FOUND`/`DEGREE_HOLDER_MISMATCH`→422; malformed input→400; HEC/store
faults→503. Only infra faults throw.

## The age-exception seam (owned here)

Degree categories carry a relaxed maximum age (university 26 = +1, specialist 27 = +2)
vs the base 18–25 band. That relaxation is only legitimate because a qualifying degree
is required and verified. `evaluateHecEducation` surfaces `appliedMaxAge` +
`ageExceptionApplies` so the age gate's relaxed band is explicitly justified and
auditable — the education verdict and the age exception share one provenance.

Specialist categories additionally require the degree field to be in the agency's
recognised set (`RDF_SPECIALIST_FIELDS` vs `RCS_SPECIALIST_FIELDS`) — the same NURSING
degree is ELIGIBLE for an RCS specialist track but INELIGIBLE for the RDF one. Proven.

## Contracts added (additive, in shared-types)

- **`HECVerifiedPayload`** (eligibility.types) — the verified-degree shape (level,
  specialist field, institution, graduation year). Mirrors `NESAVerifiedPayload`.
- **`HECDegreeVerifyRequest` / `HECDegreeVerifyResponse` / `HECVerifyReason`**
  (g2g.types) — the HEC wire contract, which had none.
- `HECVerificationCompletedEvent` already existed (routed to `vetting.hec`).

## Proof

`selfcheck/verify-degree-eligibility.ts` — a live HTTP slice over a real socket against
live PG + live usrp-hec-mock (InMemoryEventBus so events are inspected field-by-field),
**registered in the gate (`run-selfchecks.sh`) → 10/10 green**:
1. Verified degree, university category → ELIGIBLE; `appliedMaxAge=26`, `ageExceptionApplies=true`; event `degreeVerified=true`.
2. Specialist category, field recognised (ENGINEERING∈RDF) → ELIGIBLE, `appliedMaxAge=27`.
3. Specialist, field NOT recognised (NURSING∉RDF) → INELIGIBLE.
4. Same NURSING degree, RCS specialist (NURSING∈RCS) → ELIGIBLE — per-agency field set.
5. Holder mismatch (applicant presents another citizen's degree) → 422, still emits COMPLETED(false)+AUDIT.
6. Unknown registration → 422 DEGREE_NOT_FOUND.
7. A-Level category on HEC path → 409 HEC_NOT_APPLICABLE.
8. Identity predating the G2G column → 409 G2G_SUBJECT_UNAVAILABLE, no G2G call, no event (fail closed).
9. Unverified → 409; unknown applicant → 404; no events for rejected preconditions.
10. Input validation → 400.
11. HEC unreachable → 503 HEC_UNAVAILABLE, no event.
12. No secret leaks — neither the G2G subject hash nor the registration number appears
    in any response body or published event.

Repeatable + self-cleaning (fixtures deleted before and after via an admin connection,
since the app role has no DELETE — erasure is soft-delete).

## Config

Adds the HEC G2G endpoint to eligibility config (`HEC_BASE_URL`, `HEC_HMAC_SECRET`,
`HEC_REQUEST_TIMEOUT_MS`; dev mock on `:3103`). The degree route is registered in
`main.ts` alongside age + education.

## Deferred (follow-on)

- **Event-driven HEC** — `APPLICANT_SUBMITTED` now carries `applicationId`, so the HEC
  gate can go event-driven like the age gate (currently HTTP-driven). Same follow-on as
  event-driven NESA.
- **Backfill** — identities created before `0005` have a null G2G hash and fail closed
  on the degree path. A re-verification/backfill path is a separate concern.
