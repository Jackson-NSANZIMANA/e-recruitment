# application-service — the front door (APPLICANT_SUBMITTED producer)

**Status:** DONE — proven live (HTTP slice + compiled real-Kafka e2e), 2026-07-08.

## The gap this closes

`APPLICANT_SUBMITTED` was **consumed by two services** (eligibility's event-driven
age gate; the audit trail transitively) but **produced by nothing** — the true
architectural gap in the pipeline. `application-service` is the missing producer:
the front door that turns a verified applicant's *agency+category choice* into a
filed application and announces it as `APPLICANT_SUBMITTED`.

## Shape

Hexagonal, mirroring identity/eligibility. Pure producer — one HTTP route, no
consumer.

```
POST /v1/applications { applicantId, category, channel, nesaIndexNumber?, hecRegistrationNumber? }
  → PgIdentityReader     — applicant must be a known, VERIFIED identity (as usrp_system_service;
                           reads only the two UNENCRYPTED columns: identity_status, national_id_hash)
  → resolveAcademicInputs — the category fixes which credential is required (NESA vs HEC),
                            keyed off shared-types EDUCATION_REQUIREMENTS; fails closed
  → PgCampaignReader     — resolve the OPEN campaign server-side (applicant never picks a UUID):
                           REGISTRATION_OPEN, window contains now(), target_categories ∋ category
  → PgApplicationRepository — ONE transaction as usrp_system_service:
                              mint AGENCY-XXXXX from the per-agency sequence (0003),
                              INSERT applications (status SUBMITTED),
                              INSERT application_status_history (null→SUBMITTED, correlationId)
  → publish APPLICANT_SUBMITTED (only AFTER durable persistence)
```

Business outcomes are **return values**, mapped at the HTTP edge:
`SUBMITTED`→201, `APPLICANT_NOT_FOUND`→404, `IDENTITY_NOT_VERIFIED`→409,
`INVALID_ACADEMIC_INPUT`→422, `NO_OPEN_CAMPAIGN`→409; malformed input→400; infra
faults→500. Only infra faults and truly exceptional states throw.

## Decisions

1. **New service, not folded into identity/bff** — one concern per service.
2. **Requires a VERIFIED applicantId** — identity-service owns NIDA; the front door
   never re-verifies, it lifts the stored `national_id_hash` onto the event.
3. **Campaign resolved server-side** — applicants choose agency+category; the service
   finds the open campaign. A closed window is a clean `NO_OPEN_CAMPAIGN`, not an error.
4. **`agencyForCategory` / `ALL_CATEGORIES` lifted into shared-types** — the
   category↔agency map is platform-wide truth (the front door routes a submission to
   the owning agency's ops schema by it). eligibility now re-exports it.
5. **Per-agency Postgres sequence** for race-free `AGENCY-XXXXX` processing codes
   (migration 0003) — `nextval()` is atomic; officers see this anonymous code, not a name.

## Config

Leanest after audit: **runtime + database only**. The front door calls no G2G agency
(no NIDA/NESA/HEC secret) and decrypts no PII (no encryption key) — smallest blast
radius. Port env key is `PORT` (default 3000).

## Foundation gap found + fixed

`usrp_system_service` had **no grant on `public_core.recruitment_campaigns`** (0001
covered only `applicant_identities` in public_core), so the campaign reader failed
closed with *permission denied*. Fixed by **migration `0004_campaign_read_grants.sql`**:
`GRANT SELECT ON public_core.recruitment_campaigns TO usrp_system_service`. The table
carries no citizen PII (agency-scoped reference data, no RLS), so a plain SELECT grant
is the right minimal fix. Wired into `scripts/bootstrap-db.sh` (step 5).

Also caught in my own code during the slice: both seed applicants shared one
`national_id_hash` (UNIQUE) — fixed in the selfcheck.

## Proof

- **`selfcheck/verify-submit-http-slice.ts`** — 41 assertions over a real socket
  against LIVE PG (InMemoryEventBus so the event is inspected field-by-field):
  201 SUBMITTED with `RDF-NNNNN` code; APPLICANT_SUBMITTED envelope + full payload;
  persisted application + null→SUBMITTED history row with correlationId; all four
  business rejections (404/409/422/409); input 400s; health/ready; no `national_id_hash`
  in any response body. Registered in `scripts/run-selfchecks.sh` → **gate now 9/9 green**
  (no regression in the other 8).
- **Compiled real-Kafka e2e** — `node dist/main.js` with `KAFKA_BROKERS` set: a live
  `curl` POST returned `RDF-00005`, and an independent console consumer observed the
  real `APPLICANT_SUBMITTED` on topic `applicant.submitted` with `correlationId`
  preserved from the inbound `x-correlation-id` and `nationalIdHash` (never raw NID).
  Graceful SIGTERM shutdown (service_stopping→stopped) confirmed.

Category enum note: each agency ops schema has its **own** `application_category` enum
holding only its categories (rdf_ops: 4, rnp_ops: 2, rcs_ops: 4) — verified to match
shared-types exactly, so the `::schema.application_category` cast is safe.
