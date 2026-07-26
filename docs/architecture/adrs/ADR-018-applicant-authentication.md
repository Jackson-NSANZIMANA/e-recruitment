# ADR-018 — Applicant Authentication: NIDA-Phone OTP → Opaque, Revocable DB Session

**Status:** Accepted (owner-signed 2026-07-26)
**Related:** ADR-012 (walk-in lane — the fallback), ADR-015 (erasure — sessions/challenges are personal data), ADR-016 (client credentials — the me-route's machine auth), rls/0016 (challenge store + session grants)

## Context

Every human credential in the platform belonged to staff: officers log in
with passwords (rls/0010), machines with client credentials (rls/0015). **No
citizen could authenticate.** The audit called it out plainly: no applicant
auth, no self-service surface, no stored contact — the entire funnel was
officer/system-driven. Meanwhile two designed-for-this artifacts sat dormant:
`public_core.applicant_sessions` (with USSD state columns — Rwanda's
feature-phone reality was in the schema from day one) and the NIDA gateway's
`registeredPhoneNumber` field.

## Decision

### OTP to the NIDA-registered phone — fetched live, never stored

A citizen presents their NID; identity-service (which already owns the NIDA
gateway, the NID-hash key, and the PII boundary) resolves the registered
phone **from NIDA at that moment** and sends a 6-digit code there. The raw
phone exists only in memory between the lookup and the SMS send — no new PII
at rest. What lands in the DB: a scrypt digest of the code (5-minute TTL,
5-attempt lockout, single-use) and — after a successful verification — the
phone's HMAC (`phone_number_hash`) + `phone_verified_at`.

**The binding is the point**: the OTP proves control of the phone *NIDA*
associates with that NID — an attacker cannot enroll their own number. The
cost is honest and documented: a citizen whose NIDA phone is stale or absent
cannot pass this door. Their path is the walk-in lane (ADR-012), where a
field officer establishes identity in person. Identity assurance stays
anchored to government records in both lanes.

### No enumeration, iam-grade

The request endpoint returns one byte-identical 202 for a real send, an
unknown NID, an unverified identity, and a phoneless NIDA record. Every
verification failure — no challenge, expired, locked, wrong code, replayed
code — is one identical 401.

### Opaque DB session, not a JWT (owner D5, 2026-07-26)

Success mints a 32-byte crypto-random token stored in
`applicant_sessions` — **not** an Ed25519 JWT:

- **Immediate revocation.** `terminated_at` kills a session at the next
  request (proven: logout → 401, erasure → 401). Citizens lose phones;
  a stateless token can't be recalled before expiry.
- **USSD-capable.** Feature-phone flows are stateful by nature; the session
  row carries `ussd_state`/`ussd_menu_depth` for the flagged USSD follow-on.
  A multi-hundred-byte JWT cannot ride a USSD dialog.
- **shared-auth stays untouched.** The proven officer/system verify path
  gains no third kind; the citizen session is validated by identity-service
  against its own table (30-minute sliding TTL).

### The me-route dogfoods ADR-016

`GET /v1/applicants/me/applications` validates the citizen session, then
identity-service — as a machine client with its own credentials — fetches a
15-minute system token from iam-service and calls application-service's new
`GET /v1/applications/by-applicant` (system-kind, `usrp_system_service`
role, non-PII columns, union across the three ops schemas). Application
state stays inside its single-writer service (ADR-006); the citizen door
never widens an officer's view (an officer token on that route → 403, and
`listByApplicant` refuses non-system principals in the use case too).

### Erasure integration (ADR-015)

Sessions were already hard-deleted on erasure; OTP challenges now go with
them. Proven live: an erased citizen's live session answers 401 on its next
request.

## Proof (gate #32 — `verify-applicant-auth-slice.ts`)

THREE real services in-proc against live PG + NIDA mock: uniform 202s (no
enumeration, nothing sent for unknown NIDs), lockout at 5 wrong guesses
(the right code then fails too), fresh challenge → session (~30 min),
replay → 401, me/ shows own applications cross-agency and never another
citizen's, officer → 403 on the system read, logout revokes instantly, no
phone/code/session-token on the bus, erasure kills sessions + challenges.
Green ≥2×.

## Consequences

- A citizen can now authenticate and see their own application status —
  the first citizen-facing capability; the applicant UI has a real backend.
- `phone_verified_at`/`phone_number_hash` finally populate, and
  notification-service's `ContactResolver` follow-on has a verified-phone
  substrate to build on.
- Dev stack gains a `dev.identity-portal` client; identity-service main
  needs `IAM_BASE_URL`, `APPLICATION_SERVICE_BASE_URL`,
  `IDENTITY_CLIENT_ID/SECRET`.

## Follow-ons (explicitly out of scope, flagged)

1. **Rate limiting** beyond the per-challenge attempt cap — per-NID/per-IP
   request throttling (SMS cost + brute-force hygiene); shared with the
   officer-login follow-on.
2. **Session-token hash-at-rest** — the opaque token is currently stored
   verbatim; hashing it (like credentials) shrinks the DB-read blast radius.
3. **Real SMS adapter** (MTN/Airtel) behind the SmsChannel port; shared
   with notification-service.
4. **USSD flow** — the state columns exist; the menu machine does not.
5. **Encrypted contact capture** for notification delivery (the resolver
   still returns null — delivery stays PENDING_NO_CONTACT).
6. **Voluntary withdrawal + erasure self-service** — the citizen can now
   authenticate; letting them withdraw an application (WITHDRAWN's second
   writer) or demand erasure without an officer are natural next doors.
7. **Session purge** — expired/terminated rows accumulate until the
   retention sweep (ADR-019) deletes them.
