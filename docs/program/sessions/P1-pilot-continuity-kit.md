# P1 — Pilot continuity kit: paper roster, paper scores, assisted desk (backend + frontend + procedure)

**M2 · new package, pulled forward from S18 · depends on S04 (roster), S06 (W1-08 print sheets, `@usrp/ui` states) and S09 (venue live counts); runs beside or after S08** · Branches `feat/p1-continuity` (BE), `feat/p1-continuity-console` (FE) · Reserved: **ADR-046**, **`rls/0039_paper_continuity.sql`**, **ADR-FE-018**

## Why
Principle 3 of the roadmap: every automated step has a supervised manual lane. An exam day must keep running when tablets, the network or the registry fail, and nothing captured on paper may be lost or entered twice. Today:
- S06 prints a blank numbered score sheet and a roster template (W1-08), but nothing brings paper back into the record;
- `physical_test_scores` accepts only device-signed records (ADR-010), so a paper score has no lawful path in;
- there is no end-of-day reconciliation of expected, admitted, scored and paper counts;
- a citizen without a smartphone or printer has no way to get the pass ADR-033 issues.

Baseline binding decisions 8 and 9 make the paper fallback and the assisted desk pilot requirements. Drills `venue-down`, `device-lost` and `registry-down` (the M2 closing proof) all end in this kit's reconciliation.

## Delivers
1. **ADR-046 — paper records and reconciliation.** It decides:
   - **sheet custody:** every printed sheet has a server-issued serial (`public_core.paper_sheets`: venue day, kind `ROSTER | SCORE | RUN_SHEET`, issued by, issued at). At closeout every serial is accounted for as `USED`, `SPOILED` (with a reason) or `RETURNED_UNUSED`. A missing serial blocks closeout;
   - **two-person re-entry:** officer A enters a sheet. Officer B, a different principal, enters the same sheet **blind**, without seeing A's values. The server compares field by field. If all fields match, the records commit as `source = PAPER_REENTRY` (sheet serial, line, both enterers; `device_id` null; signed by the server's audit, not a device). If anything differs, the sheet goes to supervisor reconciliation, where the supervisor chooses a value per field against the physical sheet, with a reason. Both entries are kept (append-only); nothing is overwritten;
   - **coexistence with digital records:** a paper record for an application that already has a device-signed record follows the ADR-010 rule: equal values are a duplicate; different values are a **conflict** (both kept, application held, `resolveFieldSyncConflict`). An official result is never chosen silently;
   - **paper admission:** with the gate offline, the gate officer and the supervisor co-sign the roster line (processing code, ID card sighted, time). Re-entry records a `PAPER_ADMISSION` with both attestations, which satisfies ADR-034 §7 (scores require admission). Whether the candidate's national ID is written on paper is a DPO decision (below);
   - **retention:** sheets are controlled documents under the retention schedule, with the destruction date recorded.
2. **Printed roster and run sheet** from `getVenueRoster` (S04), extending S06's W1-08 templates:
   - the roster lists processing codes, categories, required paper items, an admission box and the co-sign boxes;
   - the run sheet holds the venue-day timeline, station staffing, the emergency contacts slot, the relocation and incident log, and the opening checklist (refresh the roster, device readiness, paper stock counted);
   - each is serial-numbered at print and holds no names or NIDs.
3. **Paper score sheets:** numbered lines bound to the sheet serial. The metric boxes come from `PhysicalTestMetrics` bounds, printed on the sheet, with scorer and candidate signature boxes.
4. **Operations (edge, contract-first, each with `x-usrp-permission` and `x-usrp-outcomes`):**
   - `issuePaperSheets` (venue day, kind, count) returns serials;
   - `submitPaperEntry` (serial, entry 1 or 2, lines). The second entry by the first principal is refused (`409 SAME_PRINCIPAL_FORBIDDEN`), and a resubmission is idempotent per (serial, entry);
   - `getPaperSheet` returns status and, only to a supervisor after both entries, the diff;
   - `reconcilePaperSheet` (a per-field choice and reason);
   - `markPaperSheet` (`SPOILED` or `RETURNED_UNUSED`, with a reason);
   - `getVenueDayCloseout` and `closeVenueDay`.
5. **End-of-day reconciliation (closeout).** Per venue day: roster expected; admitted (digital + paper); physical captured (digital + paper); medical recorded; open conflicts; superseded passes (S14); serials issued against accounted. The figures come from S09's projection plus the paper ledger, each with `asOf`. `closeVenueDay` is refused while any count does not balance or any conflict or serial is open (`409 CLOSEOUT_UNBALANCED` with the failing lines). The closed day is a PII-free, append-only closeout record.
6. **Assisted desk:**
   - an officer serves a citizen who has no smartphone or printer: they type the national ID from the card plus the date of birth, which identity-service hashes and forgets, as at the gate (ADR-034 §5);
   - the officer sees the application status in plain words (the ADR-033 states) and prints the citizen's pass, which is the same signed `USRP-SLOT.v1` token rendered as a QR (nothing weaker; ADR-033 §1), with venue, day, reporting hour and any relocation notice (S14);
   - new permission `assisted.desk.serve` (default: `screening_officer` and `field_supervisor`). Every lookup is audited (`ASSISTED_DESK_LOOKUP`, PII-free) and rate-limited per officer; a miss answers the same as a sibling agency's application (`NOT_FOUND`).
7. **Procedure** (written, trilingual review left to S18): `docs/runbooks/paper-fallback.md` (when to switch to paper, sheet custody, co-signing, re-entry, reconciliation), `docs/runbooks/assisted-desk.md`, and `docs/runbooks/venue-closeout.md`.
8. **Console screens** (officer console; ADR-FE-018 records where paper and desk screens live and the print pipeline): issue and print sheets, the blind re-entry form (keyboard-first, 48 px targets), the supervisor diff and reconcile view, the closeout board with the failing lines, and the assisted-desk lookup and print. Every new string is in en, rw and fr.

## Read first
ADR-010 (score records and conflicts), ADR-031, ADR-033, ADR-034 (§5 identity binding, §7 scores require admission), ADR-039 (roster), `docs/compliance/retention-schedule.md` and `dpia.md`; the S06 hand-off (W1-08 sheets, `@usrp/ui`), the S09 hand-off (live counts), the S14 kit (superseded passes); baseline §15.3 (degradation ladder).

## Owns
- the paper ledger and re-entry in `field-sync-service` (after S09 merges; append-only additions)
- the assisted-desk read in identity-service and application-service
- `rls/0039`, ADR-046, and an addendum in ADR-010
- edge controllers for these operations
- FE: `packages/features/field-ops/src/paper/**` and the assisted-desk routes, print templates, their locale keys and manifests, ADR-FE-018
- the three runbooks

**Append-only shared files:** see README §Shared files. A separate commit, rebased last.

## Work plan
1. Ask the owner and the DPO the decisions below, then write ADR-046 with the answers (or the defaults).
2. `rls/0039`: `paper_sheets`, `paper_entries`, `paper_reconciliations`, `venue_day_closeouts`. All have FORCE'd RLS and append-only triggers, with agency from the session.
3. Pure domain: `compareEntries(a, b) → MATCH | DIFF(fields)`, `decideCloseout(counts) → BALANCED | UNBALANCED(lines)`, total and exhaustive.
4. Services and edge, each operation with a proof. Selfcheck `verify-paper-continuity.ts` covers:
   - the same officer can't enter twice;
   - a blind second entry never sees the first;
   - a match commits exactly one record;
   - a diff waits for the supervisor;
   - a paper value that differs from a digital one raises a conflict and holds the application;
   - a replayed entry is a no-op;
   - closeout is refused while a serial is missing;
   - assisted-desk lookups are cross-agency refused, rate-limited and audited.
5. Rehearsal scenarios **`device-lost`** and **`registry-down`**:
   - `device-lost`: S09 revokes the tablet mid-day, then the station continues on paper, re-entry runs, and closeout balances;
   - `registry-down`: a G2G registry mock (NIDA) is unavailable, so walk-in vetting stays `pending` (never a refusal; ROADMAP §5) and the walk-in continues under supervision. Closeout lists pending vetting as a named open line, not as an imbalance.

   Add a closeout assertion to `normal-day` (today's `national-pilot-day` scenario) and to S14's `venue-down`.
6. Frontend, after the backend PR merges: re-pin, the screens, mocked E2E for every state, and the live journey.

## Quality bar
- Re-entry and closeout are tested from **real wire bodies**, and every outcome is in `x-usrp-outcomes`.
- `/security-review` is mandatory (identity lookup, permissions, evidence tables).
- **Live:** the supervisor issues sheets; persona A's physical score is written on paper; officer A and officer B enter it with one deliberate mistake; the supervisor reconciles it against the sheet; the record commits once; closeout balances; and at the assisted desk a citizen's pass is printed from their national ID and date of birth.

## Exit gate
- [ ] `normal-day`, `venue-down`, `device-lost` and `registry-down` each end in a balanced closeout in CI. This is the M2 reconciliation proof.
- [ ] Both PRs are green on their heads. The status board, capability map (paper and assisted desk rows) and G5 row are updated.
- [ ] The three runbooks are written and linked from the run sheet.

## Owner decisions (ask; default if no answer)
| Decision | Owner | Default |
|---|---|---|
| Paper fallback procedure (when to switch, who authorises) | Recruitment operations | The venue supervisor declares paper mode per station; it is logged on the run sheet and audited at re-entry |
| National ID on paper for paper admission | DPO | **No.** Use the two-person attestation (card sighted) only, and no NID on any sheet |
| Re-entry timing | Recruitment operations | Same day, before closeout. The venue cannot close until every sheet is entered |
| Assisted-desk operation (where, who staffs it) | Recruitment operations | At the district office and at each venue; `screening_officer` or `field_supervisor` staffs it |
| Who may serve the assisted desk | Agency leadership | `assisted.desk.serve` for `screening_officer` and `field_supervisor` |

## Session starter
```text
You are a principal full-stack engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Backend: ~/Documents/projects/e-recruitment-software/e-recruitment; frontend: ../e-recruitment-ui.

This is session P1 — Pilot continuity kit. Read your kit e-recruitment/docs/program/sessions/P1-pilot-continuity-kit.md, then docs/program/ROADMAP.md §2 (principle 3) and §8.4, docs/program/README.md and quality-workflow.md, and the S04/S06/S09 hand-offs; follow them.

Goal: an ADR-046 paper ledger (server-issued sheet serials, every serial accounted for at closeout), blind two-person re-entry of paper score sheets with supervisor reconciliation and ADR-010 conflicts against digital records, co-signed paper admission, printed roster and run sheet from getVenueRoster, an end-of-day closeout that refuses to close unless every count balances, and an assisted desk that prints a citizen's signed pass from their national ID and date of birth (hashed and forgotten, as at the gate). Plus the paper-fallback, assisted-desk and closeout runbooks.

Use ADR-046, rls/0039 and ADR-FE-018 only. Ask me and the DPO the kit's decisions first; use the defaults if no answer arrives. /security-review is mandatory. Done = CI green on both PR heads; normal-day, venue-down, device-lost and registry-down each end in a balanced closeout; status board and capability map updated; hand-off note.
```
