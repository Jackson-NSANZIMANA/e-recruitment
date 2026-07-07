# Eligibility Service — Age-Eligibility Slice (2026-07-07)

The `eligibility-service` is the pipeline's rule engine (age, education,
disqualifiers). This first slice implements the **age gate** end-to-end and is
the **second service** on the platform — proving the identity-service hexagonal +
`@usrp/shared-http` + compiled-`node dist` template generalizes.

## Flow

```
POST /v1/eligibility/age-check { applicantId, category }
      │  validate applicantId (UUID) + category (one of the 10)
      ▼
  IdentityReader.findApplicantById(applicantId)          [system_service; decrypt DOB]
      │
      ├─ null ─────────────────────► 404 APPLICANT_NOT_FOUND
      ├─ identity_status != VERIFIED ► 409 IDENTITY_NOT_VERIFIED (no event)
      │
      └─ VERIFIED ─► evaluateAgeEligibility(category, dob, now)   [pure domain]
                        │   AGE_CRITERIA[category] min/max band
                        ▼   emit AUDIT_ENTRY (audit.immutable) — derived age only, NO DOB
                     200 EVALUATED { eligible, category, agency, ageAtEvaluation, appliedMaxAge, reason }
```

## Architecture — hexagonal (mirrors identity-service)

| Layer | Files |
|-------|-------|
| Domain | `domain/age-rules.ts` (pure `ageInYears` + `evaluateAgeEligibility`), `domain/category-agency.ts`, `domain/eligibility.errors.ts` |
| Ports | `ports/identity-reader.ts` |
| Application | `application/evaluate-age-eligibility.service.ts` |
| Adapters | `adapters/identity.pg-reader.ts` (decrypt DOB as system service), `adapters/http/eligibility.controller.ts` |
| Composition | `config.ts`, `index.ts`, `main.ts` |

Business outcomes (`APPLICANT_NOT_FOUND`, `IDENTITY_NOT_VERIFIED`) are return
values; only infrastructure faults (`EligibilityReadError`) throw. The age rules
are a **pure function** taking `asOf` (no ambient clock), so they are trivially
testable and reusable wherever eligibility is computed.

## Ground truth & scope

- Age bands come from `AGE_CRITERIA` in `@usrp/shared-types` (traced to the
  official announcements). Agency attribution is derived from the category lists,
  so it cannot drift.
- This slice evaluates the **base** min/max band. Education/specialist age
  exceptions (+1/+2 years for university/specialist tracks) require verified
  NESA/HEC data and are the **next** eligibility slice — not applied here.

## Security posture

- The applicant's date of birth is decrypted transiently as `usrp_system_service`
  (transaction-local pgcrypto key) and is **never** returned in a response,
  written to a log, or placed in the audit event — only the derived integer age
  and the verdict are. Proven by the self-check (DOB absent from every response
  body and every published event).
- Eligibility reads the identity system-of-record directly for now. A stricter
  boundary (an internal identity read-API instead of shared table access) is a
  candidate future refinement.

## Proven live

`selfcheck/verify-age-eligibility.ts` seeds a VERIFIED and a PENDING identity
fixture (real encrypted DOB), boots the service on an ephemeral port, and drives
it over a real socket — 22 assertions: eligible (in-band) and ineligible
(over-age, strict 18–21 band) using the seeded citizen's real DOB, agency
resolution, 404/409/400 branches, correlation-id → event propagation, and the
no-DOB-leak invariant. Run with Tier-1 Postgres up:

```bash
DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
pnpm --filter @usrp/eligibility-service selfcheck
```

The compiled entrypoint (`node dist/main.js`) was also booted and shut down
gracefully (health/ready OK, SIGTERM → `service_stopping`/`service_stopped`).

## Deferred to next slices
1. Education gate: NESA (A-Level) + HEC (degree) verification, `EDUCATION_REQUIREMENTS`,
   and the education-based age exceptions — emits `NESA_/HEC_VERIFICATION_COMPLETED`.
2. Consume `APPLICANT_SUBMITTED`/`NIDA_VERIFICATION_COMPLETED` to trigger
   eligibility automatically (event-driven), rather than a direct HTTP call.
3. Composite `EligibilityResult` (citizenship + age + education + criminal).
