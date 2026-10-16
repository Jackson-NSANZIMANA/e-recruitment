# ADR-035 — Rehearsal: staged recruitment cycles on the real platform

**Status:** Accepted (2026-10-16). **Uses:** BUILD-001 control plane (campaign,
policy, sessions, publish), ADR-027 (idempotency), ADR-033 (exam QR), ADR-034
(gate admission). **Closes:** frontend revamp plan W1-10.

## Context
On a fresh development stack nothing creates a campaign. `bootstrap:db` seeds
officers but, deliberately, no `agency_admin` (campaign authoring belongs to
the separately provisioned first administrator), and the citizen OTP was not
readable outside the process. Every screen was therefore empty against the
real stack: no campaign to apply to, walk-ins refused with
`NO_WALK_IN_CAMPAIGN`, no Exam Pass to scan.

The national deployment baseline goes further than "developers need data". It
requires each pilot to **rehearse** normal operation, registry outages, venue
relocation and closeout, to train staff on realistic data, and to prove a
synthetic candidate end to end before a live cohort (baseline §13 Wave 2,
§15.10). A one-off SQL seed would unblock developers and serve none of that,
and it would bypass every guarantee the control plane exists to enforce.

## Decision
1. **A rehearsal is played, not inserted.** `tools/rehearsal` (`pnpm rehearse`)
   conducts a versioned scenario through the real interfaces only. It
   provisions the agency administrator through
   `provision_first_campaign_agency_admin` (with its audit event), then
   creates draft → immutable policy version → district sessions → publish over
   `/edge/v1/**` with the session cookie, CSRF and an `Idempotency-Key`. It
   finally confirms from the citizen's side that the public detail serves the
   campaign. No service port is called and no table is written directly.
2. **Scenarios are relative to "today"** (Africa/Kigali, the gate's clock) and
   versioned. `national-pilot-day` v1 stages one campaign per agency: RDF
   examines today (digital lane, walk-in lane and gate all rehearsable now);
   RNP and RCS are open with exams in two and three weeks. It also names the
   personas and the path each one rehearses.
3. **Re-running is safe by construction.** Commands are a pure function of
   (scenario, version, Kigali day). Instants are anchored to the calendar day,
   never the current millisecond, so a same-day replay sends byte-identical
   bodies under the same keys. A campaign that is already publicly visible is
   reported as done, because a published structure is frozen. Yesterday's
   rehearsal campaigns are closed through `registration-close`, never deleted.
   The first live re-run found exactly this: millisecond instants made the
   control plane (correctly) answer `IDEMPOTENCY_KEY_REUSED`.
4. **A rehearsal can never be mistaken for a real recruitment.**
   - Public code `REH-<AGENCY>-<YYYYMMDD>`, label `[REHEARSAL] …`, venues
     "Rehearsal Venue — <District>".
   - Legal basis `SYNTHETIC-REHEARSAL`, with a reference stating it is not a
     Government of Rwanda policy.
   - The portal marks the campaign card ("practice only") and the Exam Pass
     (banner, plus "REHEARSAL: NOT VALID FOR RECRUITMENT" as the first line on
     screen, on paper and in the downloaded PNG), via
     `isRehearsalCampaign` in `@usrp/contracts`.
5. **The policy states only what the engine enforces.** The control plane
   supplies no official thresholds. A rehearsal's policy is copied from the
   eligibility engine's own constants (`AGE_CRITERIA`,
   `EDUCATION_REQUIREMENTS`, `CRIMINAL_THRESHOLD_BY_CATEGORY`,
   `REQUIRED_DOCUMENTS`; medical mode per ADR-013), so it never advertises a
   rule the pipeline does not apply.
6. **Production is fenced off.** The conductor refuses `NODE_ENV=production`,
   any non-local database host, and any non-local edge, before opening a
   connection. The administrator is provisioned under the provisioner
   session identity *emulated* from a privileged local connection, exactly as
   the BUILD-001 HTTP proof does. That is not password authentication of the
   provisioner, and it is acceptable only because of the fence. An agency that
   already has an administrator is never given a second one; the conductor
   asks for that administrator's credentials instead.
7. **The same scenario is the live acceptance test.**
   `e-recruitment-ui/apps/applicant-portal/e2e/live-rehearsal.spec.ts`
   (opt-in, `USRP_LIVE=1`) drives both apps with no mocks: persona A signs in
   with a code from the dev SMS inbox, applies, passes the three gates, gets
   the rehearsal Exam Pass and is admitted at the gate by an officer; persona
   B is refused at the age gate. It is re-runnable the same day.

## Consequences
- A fresh developer stack reaches a complete journey with `pnpm dev` and
  `pnpm rehearse`. The stage manifest (`.rehearsal/last-run.json`) feeds
  automated journeys (W2-13).
- Pilot training and drills (relocation, outage, closeout) become further
  scenarios on the same conductor rather than new tools.
- Rehearsal data shares the development database with anything else there.
  It is identifiable by code, label and legal basis, and is closed, never
  deleted, so the audit trail stays whole.
- Open: scenarios for relocation and registry outage need backend capabilities
  that do not exist yet (operator relocation B-12a). A scenario-level "expected
  outcome" assertion runner is the next step after the live spec.

## Proof
- `tools/rehearsal`: 8 node:test cases (fence, Kigali clock, deterministic
  keys, same-day replay identity, scenario validation, policy equals engine
  constants, step classification); typecheck and lint clean.
- Live, 2026-10-16: first run staged `REH-RDF/RNP/RCS-20261016` (every step
  applied, all publicly visible); the re-run reported all three as already
  done; the database held exactly three campaigns.
- Live journey: persona A `RDF-00518` SUBMITTED → ACADEMIC_VETTING →
  DOCUMENT_REVIEW_GREEN → SLOT_ASSIGNED → PHYSICAL_TEST_SCHEDULED, one gate
  admission at "Rehearsal Venue — Gasabo"; persona B `RDF-00519` SUBMITTED →
  REJECTED ("Projected AGE verdict"). A same-day re-run passed with no new
  application or admission.
