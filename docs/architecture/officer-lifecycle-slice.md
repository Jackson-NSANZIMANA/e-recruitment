# Slice 4 — Officer lifecycle: medical → final → accept

**Status:** landed (RDF green digital lane complete to ACCEPTED). Branch `feat/autonomous-eligibility-pipeline`.

## What this slice does

Completes the human tail of the green digital lane with three **officer-authenticated write transitions**, carrying one application `PHYSICAL_TEST_COMPLETE → MEDICAL_REVIEW → FINAL_SHORTLIST → ACCEPTED` (and `REJECTED` off the medical/final gates). With this, one real submission travels autonomously from the front door all the way to a final ACCEPT, proven end-to-end against live infra.

## The novel mechanism — officer-DB-role writes

This is the **first production write path** to run `SET LOCAL ROLE usrp_<agency>_officer` instead of `usrp_system_service`. It extends the auth-slice officer-DB-role activation from reads (`GET /v1/applications`) to writes. Consequence: cross-agency isolation is now **DB-enforced for writes** — the officer role has no grant on sibling ops schemas, so a mis-routed write raises permission-denied before any RLS check. Autonomous projections (vetting/slot/notification/field-score) remain `system_service`; these officer commands are a distinct path.

Files: `ports/officer-transition-repository.ts`, `adapters/officer-transition.pg-repository.ts` (the role seam + guard/stamp/history), `application/officer-transitions.service.ts` (policy + audit), `adapters/http/officer-transitions.controller.ts` (three exact-match routes), wired in `main.ts`.

## Endpoints (exact-match routing → `applicationId` in body; all `withAuth({kind:'officer'})`)

| Endpoint | Body | Transition |
|---|---|---|
| `POST /v1/applications/medical-review` | `{applicationId, fitnessStatus:'FIT'\|'UNFIT'}` | `PHYSICAL_TEST_COMPLETE → MEDICAL_REVIEW` (FIT) or `REJECTED` (UNFIT) |
| `POST /v1/applications/final-decision` | `{applicationId, decision:'SHORTLIST'\|'REJECT', notes?}` | `MEDICAL_REVIEW → FINAL_SHORTLIST` (SHORTLIST) or `REJECTED` |
| `POST /v1/applications/accept` | `{applicationId}` | `FINAL_SHORTLIST → ACCEPTED` |

Each transition is: **idempotent** (`NO_CHANGE` when already at target), **hold-safe** (`NOT_APPLICABLE` when not at the required prior status → 409), **cross-agency guarded** (queries the officer's own agency schema → `NOT_FOUND` → 404; also DB-enforced), appends an append-only `application_status_history` row (`performed_by` = officer subjectId), and emits one `AUDIT_ENTRY` (performedBy = officer subjectId, agency) on a genuine transition only. Auth: 401 unauthenticated, 403 system token. `*_by_id` are UUID columns → officer token subjects must be UUIDs (aligns with the future issuer).

## Decisions

1. **Cross-agency accept-lock DEFERRED (owner, 2026-07-12).** `accept` moves to `ACCEPTED` only; it does **not** write `public_core.applicant_identities.cross_agency_locked_*`. Enforcing "one applicant accepted by at most one agency" is bilateral (agency B's accept must consult a lock set by agency A) and needs its own grant + RLS + double-accept proof — a focused follow-on slice, not bolted onto this one.

2. **Medical review is RDF-only — a real per-agency DIVERGENCE, not a bug.** Verified against the live DB: the medical landing columns (`medical_reviewed_by_id/_at`, `medical_fitness_status`) exist in **rdf_ops only**. RNP has **no** medical columns on `applications`; RCS models medicine as a government-physician **certificate** (`medical_cert_verified/_physician_name`). The three agencies genuinely do medical review differently. Rather than let an RNP/RCS officer hit a raw DB error, `medicalReview` guards on agency and returns a clean **501 `UNSUPPORTED_AGENCY`**, pending the tri-agency medical-modelling decision (owner/agency call). `finalDecision` and `accept` touch only mirrored columns/status and are already **tri-agency-safe**.
   > This corrects a false "mirrored rnp/rcs" claim in the prior handoff — surfaced by the slice-4 proof and confirmed against the schema.

## Verification (`selfcheck/verify-officer-lifecycle-slice.ts`, live PG + real socket, 40 assertions)

Happy path FIT→SHORTLIST→accept→ACCEPTED with every stamp/history/audit asserted · idempotent re-apply→NO_CHANGE (no new write) · UNFIT→REJECTED · final REJECT→REJECTED · hold-safe accept→409 · cross-agency RDF↔RNP→404 (DB-enforced) · **RNP medical-review→501 (agency untouched)** · 401/403/400 · exactly one AUDIT_ENTRY per genuine transition (5 total, performedBy officer UUID; APPLICATION_REJECTED vs APPLICATION_STATUS_ADVANCED) · append-only history accounting (5 in rdf_ops, 0 in rnp_ops) · no PII in any response. Registered in `scripts/run-selfchecks.sh`.

## Follow-ons

- **Tri-agency medical modelling** (RNP path, RCS certificate path) — remove the 501 guard once the model exists.
- **Cross-agency accept-lock** slice (set + bilateral enforcement + proof).
- These feed the broader pivot to the visible-value vertical (token issuer → deploy → officer console) — see the progress scorecard.
