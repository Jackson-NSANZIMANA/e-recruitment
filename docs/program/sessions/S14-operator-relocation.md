# S14 — Operator relocation and superseding invitations (backend + frontend)

**M2 · backend then frontend · depends on S04 (roster) and S09 (venue live counts, device fleet); S08 consumes the superseded-ticket list** · Branches `feat/s14-relocation` (BE), `feat/s14-relocation-console` (FE) · Reserved: **ADR-045**, **`rls/0038_relocation.sql`**

## Why
A venue can become unusable on the morning of an exam (flood, power, a road closed, a building requisitioned). Today nothing can move a candidate:
- `public_core.slot_reservations` holds exactly one row per application (PK `application_id`, append-only; ADR-026), so a second reservation is unrepresentable;
- `applications.qr_signed_token` is write-once by trigger (ADR-033, rls/0031), so a new pass cannot be issued;
- the gate (ADR-034) would answer an old pass at the new venue `WRONG_VENUE`, and a stored token that was replaced would make every old pass look forged (`TICKET_NOT_ISSUED`);
- the offline verifier rung (S08) cannot know a pass was withdrawn.

Baseline binding decision 6 makes relocation a pilot requirement, and drill `venue-down` is a closing proof of M2. ROADMAP §5 names this ADR as architecture runway.

## Delivers
1. **ADR-045 — relocation and superseding invitations.** It decides:
   - **supersession, not mutation:** a new append-only `public_core.slot_supersessions` ledger (`application_id`, `generation`, old and new ticket ids, old and new venue/day, `relocation_id`, reason, time). The original reservation row is never edited. The *current* invitation is the highest generation. `qr_signed_token`'s trigger is amended to allow replacement **only** by the projection, and only when a matching supersession row exists in the same transaction;
   - **a relocation order** (`public_core.relocation_orders`): source venue/day, target venue/day, reason code + free text, proposer, approver, state (`PROPOSED → APPROVED → APPLIED`, or `REJECTED` / `WITHDRAWN`), and the per-candidate result. FORCE'd RLS, append-only for evidence; agency from the session only;
   - **capacity:** under the venue row locks of ADR-026 §3, taken in a fixed order (lower id first) so two relocations cannot deadlock. The target is checked against `capacity_limit`, the target's `registered_count` goes up and the source's goes down. A candidate who doesn't fit stays on the original invitation and is listed as **unplaced**, never dropped silently;
   - **eligibility for a move:** only candidates not yet admitted. `ALREADY_ADMITTED` candidates are on site and are excluded with a per-row result. Withdrawn, rejected and held candidates are skipped with their reason;
   - **the scheduling signer** issues the new `USRP-SLOT.v1` token (same key, new ticket id, new venue/day); scheduling stays the only signer (ADR-009, ADR-026). Redelivery re-announces the same superseding event; it never mints twice.
2. **Operations (edge, contract-first per quality-workflow §4, each with `x-usrp-permission` and `x-usrp-outcomes`):**
   - `proposeRelocation` (source venue/day, target venue/day, reason) returns a dry-run preview: candidates affected, the capacity fit, unplaced, excluded, and the target's live counts from S09;
   - `approveRelocation` / `rejectRelocation`: the approver must be a different principal from the proposer (`409 SAME_PRINCIPAL_FORBIDDEN`). Approval applies the order idempotently, keyed by `relocation_id`, and is safe to repeat;
   - `withdrawRelocation` (proposer, before approval);
   - `listRelocations` / `getRelocation` (agency-scoped, with the per-candidate results).
3. **Gate behaviour (ADR-034 amendment).** A new outcome `409 TICKET_SUPERSEDED` sits between #3 `UNKNOWN_TICKET` and #4 `TICKET_NOT_ISSUED`. It returns the **current** venue name, day and reporting hour (no PII), so the gate officer can redirect the candidate. A superseded pass is never reported as forged. Field-sync (ADR-010) keeps binding scores to the current ticket.
4. **Offline window.** `getVenueRoster` gains `supersededTickets[]` (ticket ids only) for the venue day, and the S08 pre-download manifest carries it. The offline rung shows "superseded — send to supervisor" and still cannot spend a pass. The residual window (a device that has not refreshed its roster since the order was applied) is written down in ADR-045 and in the venue opening checklist: **refresh the roster at opening and after any relocation notice.**
5. **The citizen sees the truth.** `getMyExamInvitation` returns the current pass plus a `relocation` notice (`movedFrom` venue/day, reason code, notice time). The applicant portal shows the new QR and a trilingual "your exam has moved" banner. The old QR is never shown again. SMS remains a known gap (S12); until then the notice reaches the citizen through the portal, the printed notice posted at the old venue, and the assisted desk (P1).
6. **Console flow** (officer console, new `features/scheduling` relocation routes):
   - propose (pick the venue day, then a target from the agency's active venues, then a reason), with the dry-run preview showing counts and the unplaced list;
   - approve or reject as a second person, with a ConfirmAction stating the consequences ("412 passes will be withdrawn and reissued");
   - the order detail: per-candidate results, unplaced, a printable notice for the old venue (venue, new venue, date; processing codes only).

   It uses S06's `StateBoundary`, `QueueTable` and `ConfirmAction`.
7. **Audit and reconciliation.** `RELOCATION_PROPOSED`, `RELOCATION_APPROVED`/`REJECTED`, `INVITATION_SUPERSEDED` (per candidate) and `GATE_ADMISSION_REFUSED{TICKET_SUPERSEDED}`, all outbox-staged and PII-free. S09's venue live counts move the expected numbers from source to target, and the end-of-day reconciliation (P1) accounts for every superseded pass.

## Read first
ADR-008, ADR-009, ADR-026 (slot ledger and capacity), ADR-031, ADR-033 (citizen QR), ADR-034 (gate outcomes and their order), ADR-039 (roster, permission metadata), the S09 hand-off (live counts, device revocation), the S08 kit (offline rung); `services/scheduling-service/src/**`, the slot projection in application-service, `rls/0021` and `rls/0031`; ROADMAP §5 ("Relocation and superseding invitations", "Key custody").

## Owns
- `services/scheduling-service/**` (the superseding signer)
- the slot and supersession projection in application-service (append-only additions)
- the gate outcome addition in application-service
- `rls/0038`, ADR-045, and an addendum in ADR-034
- edge controllers for these operations
- FE: relocation routes in `packages/features/scheduling/**`, the relocation banner in the applicant portal's invitation page, and their locale keys and manifests

**Append-only shared files:** see README §Shared files. A separate commit, rebased last.

## Work plan
1. ADR-045, including the owner-decision defaults below. Ask the owner first; use the defaults if no answer arrives.
2. `rls/0038`: both tables, FORCE'd RLS, append-only triggers, the amended `qr_signed_token` trigger, and column grants only (`registered_count`).
3. Pure domain: `planRelocation(candidates, targetCapacity) → { moved, unplaced, excluded }`, total and exhaustive. `decideGateTicket` gains `TICKET_SUPERSEDED`.
4. Services and edge, one operation at a time, each with a proof. Selfcheck `verify-relocation.ts` covers:
   - the proposer can't approve;
   - cross-agency refused;
   - capacity never overshoots under two concurrent approvals;
   - an admitted candidate is excluded;
   - an old pass at either gate answers `TICKET_SUPERSEDED`, and the new pass is admitted once;
   - replaying an approval doesn't move anyone twice;
   - redelivered `SLOT_SUPERSEDED` doesn't mint a second token;
   - the source and target `registered_count` stay exact.
5. Rehearsal scenario **`venue-down`**: stage the day, relocate "Rehearsal Venue — Gasabo" to a second venue, then assert the per-candidate results, persona A's old pass refused with the redirect, the new pass admitted, the portal showing the notice, and the counts moved.
6. Frontend, after the backend PR merges: re-pin, the console flow, and the portal banner, with mocked E2E for every state and the live journey.

## Quality bar
- Every new outcome is in `x-usrp-outcomes` and tested at the edge projection (allowlist: nothing identifying leaves).
- `/security-review` is mandatory (it touches the signer, gate admission and permissions).
- **Live:** `rdf.supervisor` proposes moving the Gasabo venue day, `rdf.director` approves, persona A's portal shows the moved QR, the old QR is refused at the new gate with `TICKET_SUPERSEDED`, and the new QR is admitted.

## Exit gate
- [ ] `venue-down` passes in CI, and the counts reconcile exactly.
- [ ] Both PRs are green on their heads. The status board, capability map (relocation row), and G5 row in delivery-programme §4 are updated.
- [ ] The offline window is documented in ADR-045 and the opening checklist.

## Owner decisions (ask; default if no answer)
| Decision | Default |
|---|---|
| Who may relocate (authority) | Two-person rule: `venue.relocate.propose` for `field_supervisor` and `agency_admin`; `venue.relocate.approve` for `decision_authority`. The approver must differ from the proposer |
| Fairness: minimum notice | A same-day move only within the same district; any move to another day needs at least 24 h notice. A candidate never loses their place in the process |
| Fairness: who moves when the target is too small | Whole venue day or nothing, by default. If the owner allows splitting, use a deterministic order (processing code ascending), audited |
| Reason codes | `VENUE_UNUSABLE`, `SECURITY`, `CAPACITY`, `ADMINISTRATIVE`, plus mandatory free text |

## Session starter
```text
You are a principal full-stack engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Backend: ~/Documents/projects/e-recruitment-software/e-recruitment; frontend: ../e-recruitment-ui.

This is session S14 — Operator relocation and superseding invitations. Read your kit e-recruitment/docs/program/sessions/S14-operator-relocation.md, then docs/program/ROADMAP.md §5 and §8.4, docs/program/README.md and quality-workflow.md, and the S04/S09 hand-offs; follow them.

Goal: an ADR-045 supersession model (append-only supersession ledger and relocation orders; the original reservation is never edited), a two-person propose/approve relocation with a dry-run preview and capacity checked under venue row locks, scheduling re-signing the new USRP-SLOT.v1 pass, a TICKET_SUPERSEDED gate outcome that redirects without PII, superseded ticket ids in the venue roster for the offline rung, the citizen seeing the moved QR and notice, and a console flow. Proven by the rehearsal scenario venue-down.

Use ADR-045 and rls/0038 only. Ask me the relocation-authority and fairness decisions first; use the kit's defaults if I don't answer. /security-review is mandatory. Done = CI green on both PR heads, venue-down passing, status board and capability map updated, hand-off note.
```
