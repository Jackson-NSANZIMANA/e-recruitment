# Walk-in lane slice (Slice 6) — RDF exam-day registration through the merged funnel

**Decision record:** [ADR-012](adrs/ADR-012-walk-in-lane.md) (owner-signed
D1–D4 + the D0 cadence decision). **Gate:** proof #28,
`services/application-service/selfcheck/verify-walk-in-slice.ts`.

## What exists now

The four `WALK_IN_*` statuses — modeled since the baseline in shared-types +
`rdf_ops` only, with **zero writers** — are now written, proven, and joined
to the main funnel:

```
identity-service                    application-service (officer DB role)
POST /v1/identities/verify          POST /v1/applications/walk-in/register
(now accepts OFFICER principals) →  → WALK_IN_REGISTERED  (is_walk_in, on-site
   raw NID → NIDA → applicantId        ticket minted into qr_invitation_code,
                                       emits APPLICANT_SUBMITTED channel WALK_IN)
                                            │  autonomous gates fire unchanged;
                                            │  the AGE verdict lands via the
                                            │  normal vetting projection
                                    POST /v1/applications/walk-in/vet
                                    → WALK_IN_ON_SITE_VETTING (age ELIGIBLE)
                                    → WALK_IN_REJECTED       (age INELIGIBLE; terminal)
                                    → 409 AGE_PENDING        (verdict not landed; retry)
field-sync-service (unchanged) ───→ field.score.captured
                                    projection branches on the ROW's is_walk_in:
                                    → WALK_IN_PHYSICAL_TEST  (biometric precondition
                                       WAIVED for walk-ins — ADR-012; conflict HOLD kept)
                                    POST /v1/applications/medical-review   ← THE MERGE
                                    → MEDICAL_REVIEW → FINAL_SHORTLIST → ACCEPTED
```

Late adverse verdicts (RIB flag, academic fail after on-site vetting) route
to `ADJUDICATION_REVIEW`; officer CLEAR restores the pre-flag walk-in stage
from the append-only history. Early ones (still `WALK_IN_REGISTERED`)
fail-close to `WALK_IN_REJECTED` — now a TERMINAL status in the lifecycle.

## Files

| Layer | Change |
| --- | --- |
| `shared-auth/src/http.ts` | `PrincipalRequirement.kind` accepts any-of lists; withAuth 401/403 semantics unchanged |
| `identity-service · verify-identity.controller.ts` | verify route accepts system OR officer (walk-in on-site NIDA, D1) |
| `application-service · domain/lifecycle.ts` | `WALK_IN_REJECTED` terminal; lane-local early/late hard-fail routing |
| `application-service · ports/walk-in-repository.ts` + `adapters/walk-in.pg-repository.ts` | officer-role INSERT at `WALK_IN_REGISTERED` + on-site vet transition |
| `application-service · application/walk-in.service.ts` | policy: RDF-only 501, category-agency 422, campaign by exam window, event + audit emission |
| `application-service · adapters/http/walk-in.controller.ts` | the two officer routes |
| `application-service · ports/campaign-reader.ts` + `adapters/campaign.pg-reader.ts` | `findWalkInCampaign` (examination window + allows_walk_in) |
| `application-service · adapters/application.pg-repository.ts` | `applyPhysicalTestComplete` walk-in branch (row-truth `is_walk_in`, biometric waiver, conflict hold kept) |
| `application-service · adapters/officer-transition.pg-repository.ts` | `decide()` takes a from-status list; medical review accepts `WALK_IN_PHYSICAL_TEST` (the merge) |

No migration: `usrp_rdf_officer` already held INSERT on applications/history
and USAGE on the processing-code sequence (verified live before design).

## Proof coverage (gate #28, ~33 assertions, live PG + real socket)

Register (201, row, history attributed to officer UUID, channel-WALK_IN
event, audit) · AGE_PENDING 409 → age ELIGIBLE → vet APPLIED → idempotent
re-vet · all-pass evidence never proposes ladder statuses and never emits
`application.cleared` · score capture → `WALK_IN_PHYSICAL_TEST` with the
biometric waiver proven walk-in-scoped (digital control row still holds) ·
late flag → `ADJUDICATION_REVIEW` → officer CLEAR restores · medical FIT
merges → final → **ACCEPTED**, full history chain asserted edge-by-edge ·
age INELIGIBLE → `WALK_IN_REJECTED` terminal, immune to redelivered flags ·
RNP 501 ×2, wrong-agency category 422, unknown 404 ×2, credential 422,
system-token 403, unauth 401 · no PII in responses or events.

## Deferred (flagged, not silently dropped)

- Offline walk-in registration (CRDT + PII-on-device — own decision needed)
- On-site biometric enrolment (would retire the walk-in biometric waiver)
- Venue stamping on walk-in rows; DRAFT / WITHDRAWN writers (last 2 statuses)
