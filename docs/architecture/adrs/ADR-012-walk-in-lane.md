# ADR-012 — The walk-in lane (RDF-only): on-site identity, exam-day vetting, and the medical lane merge

**Status:** Accepted (owner-signed, 2026-07-16/19) · **Slice:** walk-in lane (Slice 6)

## Context

RDF recruitment allows candidates with no prior digital registration to show
up at an exam venue on exam day (`allowsWalkIn` on the campaign; the four
`WALK_IN_*` statuses have existed since the baseline). Verified live before
this slice: the enum values exist in **shared-types and `rdf_ops` only**
(RNP/RCS deliberately lack them — the same genuine per-agency divergence as
medical modelling), `applications.is_walk_in` existed defaulted-false, and
**nothing wrote any of the four statuses**. Field tablets already have Ed25519
device identity (migration 0009) and the physical-score capture path
(`FieldScoreCapturedEvent` even carries `isWalkIn`), the officer DB-role write
seam exists (Slice 4), and `usrp_rdf_officer` already held INSERT on
`applications`/history + sequence USAGE (no migration needed).

Four owner decisions were signed for this slice (D1–D4), plus the operating
cadence decision D0 (recorded in the role charter): targeted proofs per
commit, full gate on the slice's final commit, plan-mode kept per slice.

## Decision 1 — identity: ONLINE NIDA via the existing identity-service path

The field officer establishes the candidate's identity by calling the
existing `POST /v1/identities/verify` (raw NID → NIDA lookup → verified
`applicantId`) from the venue tablet, **online**. The route now accepts
**officer principals** alongside system ones (`withAuth` gained any-of-kind
requirements); nothing below the edge changed — two-hash contract, PII
encryption, and the PII-free audit are the proven code paths. Offline walk-in
registration (raw NID captured on a disconnected tablet, verified on sync) is
a **flagged follow-on**, not silently unsupported: it would extend the
ADR-010 CRDT pattern and put PII on devices, so it needs its own decision.

## Decision 2 — on-site vetting asserts: NIDA-verified + autonomous AGE verdict

`WALK_IN_ON_SITE_VETTING` means exactly: identity NIDA-verified in person
(registration precondition) **and** the age gate passed. Registration emits
the same `APPLICANT_SUBMITTED` (channel `WALK_IN`) as the digital front door,
so the autonomous age/academic/criminal gates fire **unchanged**; the vet
endpoint gates on the age verdict the projection lands on the row (PENDING →
retryable 409 — the verdict arrives in seconds while the candidate stands
there). RIB/academic continue asynchronously: an adverse verdict landing
**before** vetting fail-closes the lane; **after** vetting it routes to
`ADJUDICATION_REVIEW` (ADR-011's rule, lane-adjusted — see below). A
synchronous venue-blocking RIB check was rejected: it couples exam-day
throughput to G2G availability.

## Decision 3 — lane merge: walk-ins join the main funnel at MEDICAL_REVIEW

After `WALK_IN_PHYSICAL_TEST` (score captured), the officer medical-review
endpoint accepts the row (`decide()` now takes a from-status **list**:
`PHYSICAL_TEST_COMPLETE | WALK_IN_PHYSICAL_TEST`) — from `MEDICAL_REVIEW`
onward there is **one funnel** (medical → final → accept), so the future
cross-agency accept-lock covers walk-ins with no extra machinery. The
alternative (a parallel walk-in back-half) was rejected on a verified fact:
no `WALK_IN_ACCEPTED` status exists, so a parallel lane **cannot terminate
positively** without duplicating the entire back half across schema + types.

## Decision 4 — writer: officer-auth endpoints on application-service

`POST /v1/applications/walk-in/register` and `/walk-in/vet`, officer-token
authenticated, running **as the officer's DB role** — the first officer-role
INSERT of an application row (engine-enforced agency isolation; ADR-006
single-writer honored literally). Registration resolves the campaign by the
**examination window + allows_walk_in** (registration windows are closed on
exam day), mints the on-site ticket into `qr_invitation_code` (the
`SignableFieldPayload.qrInvitationCode` anchor — field-score capture works
identically for both lanes), and RNP/RCS officers get a clean
`501 UNSUPPORTED_AGENCY` (the medical-501 divergence mirror). Registration
via a field-sync device-signed event was rejected as contradicting D1-online
and introducing row-creation-by-projection for a synchronous act.

## Lifecycle geometry (the pure-domain consequences)

`WALK_IN_*` ranks **after** the digital ladder in `APPLICATION_STATUSES` — a
parallel entry ramp, not later stages. Two latent defects were fixed and the
lane's fail geography defined in `deriveApplicationStatus`:

- `WALK_IN_REJECTED` joined the TERMINAL set (otherwise a redelivered flag
  would rank it ≥ SLOT_ASSIGNED and un-terminate it into adjudication).
- Hard fail at `WALK_IN_REGISTERED` → `WALK_IN_REJECTED` (lane-local
  autonomous fail-closed); at/past `WALK_IN_ON_SITE_VETTING` →
  `ADJUDICATION_REVIEW` (the walk-in eligibility terminal is the on-site
  gate). Officer CLEAR restores the pre-flag walk-in stage from history.
- Max-rank monotonicity already guarantees the projection never proposes
  ladder statuses on walk-in rows (all-pass evidence changes nothing, and no
  `application.cleared` is emitted — the slot lane never fires for walk-ins).
- The physical-test projection branches on the ROW's `is_walk_in` (never the
  event's claim), **before** the rank-based idempotency check that would
  misread walk-in ranks as "already complete".

## Biometric waiver (explicit, walk-in-scoped)

The biometric check-in gate verifies a **signed slot-invitation QR** that a
walk-in cannot possess. Their identity was NIDA-verified **in person by the
registering officer at the same venue minutes earlier**, so the physical-test
projection waives the `biometric_verified_at` precondition **for walk-in rows
only** (proven not to leak to digital rows). On-site biometric enrolment
(capture at registration, gate before the test) is a flagged follow-on.

## Consequences

- 17 of 19 statuses now reachable (remaining: DRAFT, WITHDRAWN — no writers).
- A walk-in travels: register → on-site vet → physical test → (merge) →
  medical → final → **ACCEPTED**, proven e2e in
  `verify-walk-in-slice.ts` (gate proof #28) with fail-closed proofs for both
  the early and late adverse paths.
- Deferred, flagged: offline walk-in registration (CRDT extension + PII-on-
  device decision), on-site biometric enrolment, venue stamping on walk-in
  rows (`venue_assignment_id` stays null — the candidate is physically at the
  venue; scores bind via the ticket, not the venue).
