# ADR-029 — Citizen onboarding: National ID + DOB → phone → OTP

**Status:** Accepted (implemented in identity-service + edge-gateway)
**Supersedes:** the "OTP to the NIDA-registered phone" flow of ADR-018.

## Context
ADR-018 sent the OTP to `registeredPhoneNumber` from a live NIDA lookup. NIDA
does not hold SIM-registration phones (MTN/Airtel do), and the flow required an
identity row that only the officer walk-in lane could create — a new citizen
could never receive an OTP.

## Decision
1. `POST /edge/v1/auth/applicant/identity` — National ID **and date of birth**
   are checked against NIDA (Rwandan citizen, DOB equal). The identity row is
   created or reused; a stateless HMAC onboarding token (15 min) is returned.
   Unknown NID, non-citizen and DOB mismatch return one indistinguishable 422.
2. `POST /edge/v1/auth/applicant/otp/request` — token + the phone the citizen
   states (MTN 078/079, Airtel 072/073, normalised to `+2507XXXXXXXX`).
3. `POST /edge/v1/auth/applicant/otp/verify` — token + phone + code. The stored
   OTP digest is over `code|HMAC(phone)`, so a code cannot verify another
   number. On success the phone becomes the stored contact (ADR-021).

## Consequences
- The OTP proves **control of a phone**, not ownership of the NID. The DOB is
  the second factor; exam-day face match against NIDA remains the real proof.
- DOB is guessable by enumeration, so a **durable** lockout backs the edge's
  per-minute bucket: `public_core.onboarding_attempts` (rls/0028), keyed by the
  NID HMAC. 5 DOB mismatches of a real citizen within 1 h lock that NID for
  1 h; a locked NID answers the same 422 without consulting NIDA, even for the
  correct DOB. Unknown NIDs are never counted (no table growth). Known
  trade-off: an attacker can lock a victim out for an hour; recovery is to
  wait or use the walk-in lane.
- Only a **VERIFIED** identity is issued a token (an existing PENDING / FAILED
  / EXPIRED row gets the uniform answer) — the bar the pre-ADR-029 login held.
- The edge's per-phone OTP bucket keys on the canonical subscriber number
  (last nine digits), so spacing or prefix variants share one bucket.
- **Residual risk — contact replacement.** Whoever holds a citizen's NID AND
  DOB can complete onboarding with their own phone, which replaces the stored
  contact (stampPhoneVerified overwrites). The DOB factor narrows this; it does
  not remove it. Recommended (not implemented): notify the previously verified
  number when the stored contact changes, and require venue face-match before
  any irreversible step.
- The onboarding token is a 15-minute bearer of "knew NID + DOB"; it is held in
  page memory only and is not bound to the browser session (accepted for now).
- No SMS provider is chosen: delivery uses `LogSmsChannel` (fails closed).
- Account recovery for a lost phone = repeat the flow with NID + DOB.
