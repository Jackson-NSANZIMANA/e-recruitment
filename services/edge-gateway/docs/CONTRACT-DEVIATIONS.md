# Edge contract deviations

`openapi/edge-v1.yaml` was written before any upstream controller had been read.
Its own header says so: every operation marked `x-usrp-verified:
pending-controller-read` carries a body that was *inferred*, with the
instruction **"Read it, then remove the marker. Do not implement a body from
this document alone."**

The controllers have now been read. This file is the result — the authoritative
record of where the draft and the code disagree, and which one the
implementation follows. It is deliberately a separate document rather than a
silent rewrite of the spec: a 1000-line YAML edited in the same change that
introduces its implementation is not reviewable, and this repository has already
paid for one interface document that nobody could check.

**The spec should be updated from this file, and the
`pending-controller-read` markers dropped as each row lands.** Until then, where
the two disagree, this file and the code are right.

Legend: **F** = the frontend registry was followed (authoritative for path,
method, session kind, retry). **U** = the upstream controller was followed
(authoritative for bodies and outcomes).

---

## 1. `walk-in/register` — the draft body does not exist upstream (U)

**Draft:** `{ nationalId, postCode, note? }`
**Upstream `walk-in.controller.ts`:** `{ applicantId, category, nesaIndexNumber?, hecRegistrationNumber? }`

There is no `postCode` anywhere in the platform, and `category` (one of the ten
`ALL_CATEGORIES`) is required. `applicantId` is an opaque UUID the browser must
never hold.

**Implemented:** the edge accepts `{ nationalId, category, nesaIndexNumber?,
hecRegistrationNumber? }`, resolves `nationalId → applicantId` server-side
through the brokered `verifyIdentity` (channel `WALK_IN`), and forwards the
opaque id. Two upstream calls, one browser operation — which is what an edge is
for. The applicant id never travels back.

## 2. `verifyIdentity` cannot return `fullName` (U)

**Draft:** `{ verified, fullName? }`, "Returns the verified name only."
**Upstream `verify-identity.controller.ts`:** `{ status, applicantId }` — no
name, on purpose ("the edge gets only the opaque applicant UUID").

No read in the platform produces a verified name. A response schema promising
one is how a UI ends up rendering `undefined` to an officer.

**Implemented:** `{ verified: boolean }`. `applicantId` is also withheld — the
officer console identifies people by processing code, and every officer read
upstream omits the applicant key for the same reason.

## 3. The four transitions have four vocabularies, not one `outcome` string (U)

The draft's `TransitionRequest` is a shared envelope with a free-ish `outcome`
and warns that the real unions must be transcribed. Transcribed:

| operation | upstream body |
|---|---|
| `medicalReview` | `{ applicationId, fitnessStatus: FIT\|UNFIT }` (RDF board) **or** `{ applicationId, certVerdict: CERT_VERIFIED\|CERT_REJECTED, physicianName? }` (RNP/RCS certificate) — ADR-013 |
| `recordFinalDecision` | `{ applicationId, decision: SHORTLIST\|REJECT, notes? }` |
| `acceptApplication` | `{ applicationId }` |
| `adjudicateApplication` | `{ applicationId, decision: CLEAR\|REJECT, notes? }` |

**Implemented:** the browser sends `{ applicationId, outcome?, note? }` as the
draft describes, and **the edge derives the medical MODE from the officer's
session agency** — which makes upstream's `422 INVALID_MEDICAL_INPUT`
structurally unreachable from a browser instead of an error clients learn to
avoid. `outcome` is validated against the per-operation vocabulary; `accept`
takes none.

## 4. `note` is bounded at 1000, not 4000 (U)

`OfficerNote` is `maxLength: 4000`. `final_decision_notes` is a
`varchar(1000)`, and the status-history `reason` is `varchar(200)` (upstream
truncates). Accepting 4000 characters would return a 500 from the database for a
request the edge had already called valid. The edge rejects over 1000 with `422
INVALID_NOTE`.

## 5. `withdrawMyApplication` has no `reason` upstream (U)

The draft accepts `{ applicationId, reason? }`. Upstream `ME_WITHDRAW_PATH`
takes `{ applicationId }` only — there is no column for a reason. The edge
accepts the field (client contract stays stable) and **does not forward it**, in
the open, at the controller. Storing it needs a column and an ADR-020 amendment.

## 6. `fileMyErasureRequest` has no `409` (U)

The draft returns `409` when a request is already open. Upstream files
**idempotently** and answers `202` either way — "the demand is on record, a
human decides next". The edge always answers `202 { accepted: true }`. The `409`
is unreachable and should be struck from the spec.

## 7. `getMyErasureRequest` also returns the decision ground (U, widened)

The draft returns `{ exists, status?, filedAt? }` with `additionalProperties:
false`. Upstream also carries `decidedAt` and `decisionNote`, and its controller
is explicit: *"The ground is the citizen's to see — it answers THEIR demand."*
Withholding it would leave a Law N° 058/2021 right formally honoured and
practically empty. The edge returns `{ exists, status?, filedAt?, decidedAt?,
decisionNote? }`.

## 8. Channel `FIELD` does not exist in the platform (F, translated)

The registry offers `WEB | USSD | FIELD`. `APPLICATION_CHANNELS` (and the
`public_core.application_channel` enum) are `WEB | USSD | IREMBO_KIOSK |
WALK_IN`. Sending `FIELD` upstream is a `400 INVALID_CHANNEL` every time.

The edge maps `FIELD → WALK_IN` in exactly one place
(`adapters/http/channel.ts`). `IREMBO_KIOSK` is deliberately not reachable from
a browser: a kiosk is a different physical trust context and claiming it from a
web session is an unverifiable assertion about where the person is standing.

## 9. List rows carry `processingCode` and `category` (U, widened)

The draft's `ApplicationListItem` is `{ applicationId, status, agency,
submittedAt }` and is marked pending. Upstream returns `processingCode` and
`category` too. Both are non-PII and the console is unusable without the
processing code — it is the anonymous stand-in for the applicant on every
officer surface. Added.

## 10. `400 INVALID_APPLICATION_ID` on the single-record reads (added)

The draft lists no `400` for `by-id` / `detail` / `status-history`. A malformed
`applicationId` cannot be a real one, so answering `400` reveals nothing about
what exists — and it stops a client bug looking exactly like a missing record
for the rest of its life. The bare `404` is untouched for every well-formed id.

## 11. The 12-hour absolute ceiling is not achievable today (upstream limit)

`EDGE_SESSION_ABSOLUTE_TTL_SECONDS` defaults to 43200 (12h). The credentials the
edge holds live **one hour** (officer Ed25519 JWT, `OFFICER_TOKEN_TTL_SECONDS`)
and **thirty minutes** (citizen opaque token), and neither has a re-issue path
that does not involve the human authenticating again.

The edge therefore reports `absoluteExpiresAt = min(configured, credential
expiry)`. A 12-hour handle over a 1-hour JWT would tell the UI a comfortable lie
and then start 401ing at minute 61. **Lengthening a session needs an upstream
credential-refresh road, which is an ADR-016 decision, not an edge setting.**

## 12. `ME_WITHDRAW_PATH` is not exported by identity-service (upstream gap)

`identity-service/src/index.ts` re-exports `OTP_REQUEST_PATH`,
`OTP_VERIFY_PATH`, `ME_APPLICATIONS_PATH` and `LOGOUT_PATH` but omits
`ME_WITHDRAW_PATH`, so the citizen's own withdrawal route (ADR-020) is
unreachable from any other package. The edge composes it from the exported
`ME_APPLICATIONS_PATH`. **One-line fix upstream; delete the composition when it
lands.**

## 13. ADR-021 is used twice (numbering collision)

`docs/architecture/adr/ADR-021-edge-tier.md` is "the edge tier".
`scripts/run-selfchecks.sh` and `rls/0018_stored_contact.sql` both attribute
"stored contact for invitation delivery" to ADR-021, and the notices work to
ADR-022. Two decisions share a number. Not blocking, and worth renumbering
before either is cited in an audit.
