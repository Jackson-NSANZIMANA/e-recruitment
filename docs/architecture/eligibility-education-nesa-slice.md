# Eligibility Service — Education Gate: NESA A-Level Slice (2026-07-08)

Completes the *education* half of `eligibility-service`'s stated responsibility
(age **and** education) with the **NESA (A-Level) verification** path — the first
of two education legs (NESA A-Level now, HEC degrees next). It is the platform's
**second live G2G integration**, mirroring the identity-service → NIDA template.

## Flow

```
POST /v1/eligibility/education-check { applicantId, applicationId, category, nesaIndexNumber }
      │  validate applicantId/applicationId (UUID) + category (one of 10) + index
      ▼
  IdentityReader.findApplicantById(applicantId)          [system_service; VERIFIED guard]
      │
      ├─ null ──────────────────────────► 404 APPLICANT_NOT_FOUND
      ├─ identity_status != VERIFIED ────► 409 IDENTITY_NOT_VERIFIED (no event)
      ├─ category not NESA path (degree) ► 409 NESA_NOT_APPLICABLE (no event)
      │
      └─ VERIFIED + NESA path ─► NesaGateway.lookupResults(indexNumber)   [G2G, HMAC-signed]
                                    │
                                    ├─ NOT_FOUND ─► fail-closed INELIGIBLE
                                    │                emit events, return 422 NESA_RECORD_NOT_FOUND
                                    │
                                    └─ FOUND ─► evaluateNesaEducation(category, payload, now)  [pure]
                                                  │  accepted level + (RCS 4-yr) science ≥70%
                                                  ▼  emit NESA_VERIFICATION_COMPLETED (vetting.nesa)
                                                  ▼  emit AUDIT_ENTRY (audit.immutable) — no PII
                                               200 EVALUATED { academicStatus, eligible, agency,
                                                               requiredMinLevel, evaluatedLevel, reason }
```

## Architecture — hexagonal (extends the age slice)

| Layer | Files |
|-------|-------|
| Domain | `domain/education-rules.ts` (pure `evaluateNesaEducation` + `NESA_QUALIFICATION_TO_EDUCATION_LEVEL`), `domain/nesa.types.ts` (`NesaLookupResult`, `NesaUnavailableError`) |
| Ports | `ports/nesa.gateway.ts` (`NesaGateway`) — the existing `IdentityReader` is reused verbatim |
| Application | `application/verify-nesa-education.service.ts` |
| Adapters | `adapters/nesa.http-gateway.ts` (G2G HMAC-signed lookup), `adapters/http/education.controller.ts` |
| Composition | `config.ts` (`loadNesaConfig`), `index.ts` (`createEligibilityService` now returns `{ age, education }`), `main.ts` (adds the education route) |

Business outcomes are return values; only infrastructure faults
(`NesaUnavailableError`, `EligibilityReadError`) throw. `evaluateNesaEducation`
is a **pure function** taking `asOf` — no ambient clock, no I/O.

## Key decisions

1. **Age-exception coupling is deferred to HEC, not here.** The +1/+2-year age
   bumps apply only to university/specialist (degree/HEC) categories. Every
   NESA/A-Level category carries a flat base age cap, so the NESA slice is fully
   decoupled from `age-rules.ts`. The `AgeCriteria.maxAgeExceptions` seam is the
   HEC slice's responsibility.
2. **HTTP-first (event-driven deferred).** `NESA_VERIFICATION_COMPLETED` requires
   an `applicationId`, which `APPLICANT_SUBMITTED` does not carry. The synchronous
   HTTP endpoint supplies it; an event-driven trigger is a follow-on (needs a
   contract change or a distinct trigger + consumer group).
3. **Stateless evaluator (no DB write-back).** Like the age gate, and because no
   application-creation service exists yet, the slice does not persist to
   `*_ops.applications`. It reads identity, calls NESA, evaluates, emits, returns.
4. **Fail-closed.** A missing NESA record, an absent required science score, or an
   unmet level all yield `INELIGIBLE` — never a pass on missing data. The
   completed + audit events are still emitted so the decision is durable/traceable.
5. **HMAC-signed even though the dev mock ignores it.** The gateway signs every
   request with the NESA-shared secret (same `x-hmac-signature`/`x-request-id`/
   `x-timestamp` scheme as NIDA), so it is forward-compatible with a real,
   signature-enforcing NESA. **G2G signing is HMAC-SHA256, not Ed25519** (Ed25519
   is field-officer device signing only, ADR-003).

## Ground truth & scope

- Education requirements come from `EDUCATION_REQUIREMENTS` in `@usrp/shared-types`
  (traced to the official announcements): accepted levels per category, and the
  RCS `OFFICER_FOUR_YEAR_UR` `minScienceGradePercent: 70`.
- NESA lookup is keyed purely by the public examination index number — it carries
  no National ID and no PII in the request (contrast HEC, which binds a degree to
  a `holderNationalIdHash`).
- The UR-program match for `OFFICER_FOUR_YEAR_UR` needs the applicant's *declared*
  program (not in a NESA results payload) and is left to the HEC/application slice.

## Security posture

- No PII leaks: the candidate's school name and raw index never appear in a
  response body or an event; only the derived academic verdict
  (`academicStatus`, `requiredMinLevel`, `evaluatedLevel`, `reason`) is exposed.
  The audit entry deliberately records only derived facts. Proven by the
  self-check (school + DOB absent from every body and every published event).
- The `usrp_app` login `SET LOCAL ROLE usrp_system_service` per transaction and
  reads the identity table under FORCE'd RLS (reused `PgIdentityReader`).

## Proven live

`selfcheck/verify-education-eligibility.ts` seeds a VERIFIED and a PENDING
identity fixture, boots the education route on an ephemeral port with a **real
`NesaHttpGateway` against the live `usrp-nesa-mock` (`:3101`)**, and drives it
over a real socket — asserting: A-Level pass (ELIGIBLE + both events with the
inbound correlationId), RCS science ≥70% **pass (82%)** and **fail (61%)**,
fail-closed 422 on a bogus index (still emits an INELIGIBLE completed event),
409 `NESA_NOT_APPLICABLE` for a degree category, 409 unverified (no event), 404
unknown, 400 validation (id/category/index), 503 when NESA is unreachable
(injected failing `fetch`, no event emitted), and the no-PII-leak invariant.

```bash
DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
NESA_BASE_URL='http://localhost:3101' NESA_HMAC_SECRET='dev_nesa_hmac_secret' \
pnpm --filter @usrp/eligibility-service selfcheck:education
```

Two NESA fixtures were added (`RW2024/SCI-PASS` 82%, `RW2024/SCI-LOW` 61%) to
exercise the science-percentage branch; the mock loads its data file at boot, so
it is restarted after fixture edits.

## Deferred to next slices
1. **HEC degree verification** — the degree path; needs `nationalIdHash` (extend
   `IdentityReader`), a new `HECVerifiedPayload` wire type, and it **owns** the
   age-exception seam (`maxAgeExceptions`, +1/+2 for university/specialist).
2. **Event-driven NESA/HEC** — add `applicationId` to `APPLICANT_SUBMITTED` (a
   shared-types contract change) or use a distinct trigger + consumer group.
3. **Composite `EligibilityResult`** — citizenship + age + education + criminal,
   assembled once all gates report.
